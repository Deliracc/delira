// The rails engine: a separate agent wallet per account and five checks that run before DELIRA signs anything for it.
// The agent never sees the key: it sends a request over the API, the rails decide, DELIRA signs and broadcasts.
//   PROOF  every amount needs a source (invoice, quote, feed); a stated USD value must match our own price
//   LIMIT  a per-request cap and a daily cap in USD (UTC day); paused = nothing moves
//   ROUTE  only allowed networks and allowed addresses; look-alike addresses are named as such
//   PLAIN  the transaction in plain words; unknown calls and unlimited approvals are not signed
//   WAIT   no memo → a question back; above the review line → waits on a timelock the owner can cancel or approve early
// The first rail that says no stops the request with a sentence a human can act on. Keys are AES-256-GCM encrypted at rest.
import crypto from 'node:crypto';
import { NETWORKS, COINS, fmtUnits } from './networks.mjs';
import { newKey, addressOf, checksum, signTx, erc20, decodeCall } from './evm.mjs';

export const RAILS = ['PROOF', 'LIMIT', 'ROUTE', 'PLAIN', 'WAIT'];
const NATIVE = { ethereum: 'ETH', bsc: 'BNB', polygon: 'POL', arbitrum: 'ETH', base: 'ETH' };
const EXPLORER = { ethereum: 'https://etherscan.io', bsc: 'https://bscscan.com', polygon: 'https://polygonscan.com', arbitrum: 'https://arbiscan.io', base: 'https://basescan.org' };
const SOURCES = ['invoice', 'quote', 'feed', 'contract'];
const COUNTED = "('waiting','queued','signed','sent','confirmed')";   // statuses that use up the daily cap
const MAXU = (1n << 256n) - 1n;
const DEFAULTS = { daily_usd: 5, per_tx_usd: 5, wait_usd: 2, timelock_min: 15, chains: Object.keys(NETWORKS), allow: [], paused: false, tolerance_pct: 2 };
const MAX_ALLOW = 50;
const pow10 = (n) => 10n ** BigInt(n);
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const usd = (micro) => '$' + (micro / 1e6).toFixed(2);
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const bad = (message) => ({ error: message, status: 400 });

function parseUnits(amount, dec) {
  const s = String(amount ?? '').trim();
  if (!/^\d{1,18}(\.\d{1,30})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  if (f.length > dec) return null;
  return BigInt(w) * pow10(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
}

export function makeRails({ db, secret, price, rpcOverrides = {}, fetchImpl = fetch, now = () => Date.now(), log = () => {}, notify = null, allowDelayMin = 10, live = true, halted = false,
  keyCap = () => null, keySecret = () => null, hook = null, bumpAfterMin = 10 }) {
  const KEY = crypto.createHash('sha256').update('delira-agent-wallet:' + secret).digest();
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS agent_wallets (uid TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, enc TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rails_settings (uid TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rails_requests (
      id TEXT PRIMARY KEY, uid TEXT NOT NULL, idem TEXT, kind TEXT NOT NULL, via TEXT, chain TEXT NOT NULL, asset TEXT, to_addr TEXT,
      units TEXT, dec INTEGER, usd INTEGER NOT NULL DEFAULT 0, memo TEXT, proof TEXT,
      status TEXT NOT NULL CHECK (status IN ('stopped','waiting','queued','signed','sent','confirmed','failed','cancelled')),
      rail TEXT, reason TEXT, question TEXT, plain TEXT, checks TEXT,
      tx_to TEXT, tx_value TEXT, tx_data TEXT, raw TEXT, tx TEXT, nonce INTEGER,
      created INTEGER NOT NULL, release_at INTEGER, sent_at INTEGER, updated INTEGER NOT NULL, UNIQUE(uid, idem));
    CREATE INDEX IF NOT EXISTS rr_uid ON rails_requests(uid, created);
    CREATE INDEX IF NOT EXISTS rr_status ON rails_requests(status);
    CREATE TABLE IF NOT EXISTS rails_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, at INTEGER NOT NULL, who TEXT, what TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS ra_uid ON rails_audit(uid, at);
  `);
  // columns added after the first release (kept as ALTERs so an existing database upgrades in place)
  for (const col of ['key_id TEXT', 'callback TEXT', 'cb_status TEXT', 'cb_tries INTEGER NOT NULL DEFAULT 0', 'cb_next INTEGER', 'fees TEXT', 'bumps INTEGER NOT NULL DEFAULT 0', 'hashes TEXT', 'bumped_at INTEGER']) {
    try { db.db.exec('ALTER TABLE rails_requests ADD COLUMN ' + col); } catch { }
  }
  db.db.exec('CREATE INDEX IF NOT EXISTS rr_cb ON rails_requests(cb_next) WHERE callback IS NOT NULL');
  const q = {
    wallet: db.q('SELECT * FROM agent_wallets WHERE uid = ?'),
    walletIns: db.q('INSERT OR IGNORE INTO agent_wallets(uid, address, enc, created) VALUES (?, ?, ?, ?)'),
    setGet: db.q('SELECT json FROM rails_settings WHERE uid = ?'),
    setPut: db.q('INSERT INTO rails_settings(uid, json, updated) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET json = excluded.json, updated = excluded.updated'),
    used: db.q(`SELECT COALESCE(SUM(usd), 0) AS u FROM rails_requests WHERE uid = ? AND kind <> 'withdraw' AND status IN ${COUNTED} AND created >= ?`),
    usedBut: db.q(`SELECT COALESCE(SUM(usd), 0) AS u FROM rails_requests WHERE uid = ? AND kind <> 'withdraw' AND status IN ${COUNTED} AND created >= ? AND id <> ?`),
    usedKey: db.q(`SELECT COALESCE(SUM(usd), 0) AS u FROM rails_requests WHERE uid = ? AND key_id = ? AND kind <> 'withdraw' AND status IN ${COUNTED} AND created >= ? AND id <> ?`),
    usedAddr: db.q(`SELECT COALESCE(SUM(usd), 0) AS u FROM rails_requests WHERE uid = ? AND to_addr = ? AND kind <> 'withdraw' AND status IN ${COUNTED} AND created >= ? AND id <> ?`),
    audIns: db.q('INSERT INTO rails_audit(uid, at, who, what, detail) VALUES (?, ?, ?, ?, ?)'),
    audList: db.q('SELECT at, who, what, detail FROM rails_audit WHERE uid = ? ORDER BY id DESC LIMIT ?'),
    cbDue: db.q("SELECT * FROM rails_requests WHERE callback IS NOT NULL AND (cb_status IS NULL OR cb_status <> status) AND (cb_next IS NULL OR cb_next <= ?) LIMIT 20"),
    cbOk: db.q('UPDATE rails_requests SET cb_status = ?, cb_tries = 0, cb_next = NULL WHERE id = ?'),
    cbFail: db.q('UPDATE rails_requests SET cb_tries = ?, cb_next = ?, cb_status = ? WHERE id = ?'),
    fees: db.q('UPDATE rails_requests SET fees = ? WHERE id = ?'),
    bumped: db.q("UPDATE rails_requests SET raw = ?, tx = ?, fees = ?, hashes = ?, bumps = bumps + 1, bumped_at = ?, updated = ? WHERE id = ? AND status = 'sent'"),
    mined: db.q("UPDATE rails_requests SET tx = ? WHERE id = ? AND status = 'sent'"),
    ins: db.q(`INSERT INTO rails_requests(id, uid, idem, kind, via, chain, asset, to_addr, units, dec, usd, memo, proof, status, rail, reason, question, plain, checks, tx_to, tx_value, tx_data, created, release_at, updated, key_id, callback)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    byIdem: db.q('SELECT * FROM rails_requests WHERE uid = ? AND idem = ?'),
    get: db.q('SELECT * FROM rails_requests WHERE id = ?'),
    mine: db.q('SELECT * FROM rails_requests WHERE uid = ? ORDER BY created DESC LIMIT ?'),
    pending: db.q("SELECT COUNT(*) AS n FROM rails_requests WHERE uid = ? AND status = 'waiting'"),
    due: db.q("SELECT * FROM rails_requests WHERE status = 'waiting' AND release_at <= ?"),
    work: db.q("SELECT * FROM rails_requests WHERE status IN ('queued','signed') ORDER BY created LIMIT 20"),
    sent: db.q("SELECT * FROM rails_requests WHERE status = 'sent' AND updated < ? LIMIT 50"),
    set: db.q('UPDATE rails_requests SET status = ?, rail = COALESCE(?, rail), reason = ?, updated = ? WHERE id = ? AND status = ?'),
    signed: db.q("UPDATE rails_requests SET status = 'signed', raw = ?, tx = ?, nonce = ?, updated = ? WHERE id = ? AND status = 'queued'"),
    sentOk: db.q("UPDATE rails_requests SET status = 'sent', sent_at = COALESCE(sent_at, ?), updated = ? WHERE id = ? AND status = 'signed'"),
    touch: db.q('UPDATE rails_requests SET updated = ? WHERE id = ?'),
    lastNonce: db.q("SELECT MAX(nonce) AS n FROM rails_requests WHERE uid = ? AND chain = ? AND status IN ('signed','sent')"),
  };

  // one account at a time: checking a request and writing it down happen together, so parallel requests cannot all fit under the same daily cap
  const locks = new Map();
  function locked(uid, fn) {
    const prev = locks.get(uid) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {}).then(() => { if (locks.get(uid) === tail) locks.delete(uid); });
    locks.set(uid, tail);
    return run;
  }

  /* ---------- audit: who changed what, shown to the owner ---------- */
  function audit(uid, who, what, detail) { q.audIns.run(uid, now(), who ? String(who).slice(0, 80) : null, String(what).slice(0, 40), detail ? String(detail).slice(0, 600) : null); }

  /* ---------- keys ---------- */
  const enc = (uid, k) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv); c.setAAD(Buffer.from(uid)); const e = Buffer.concat([c.update(k), c.final()]); return Buffer.concat([iv, c.getAuthTag(), e]).toString('base64'); };
  const dec = (uid, b) => { const r = Buffer.from(b, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', KEY, r.subarray(0, 12)); d.setAAD(Buffer.from(uid)); d.setAuthTag(r.subarray(12, 28)); return Buffer.concat([d.update(r.subarray(28)), d.final()]); };
  function wallet(uid) { const w = q.wallet.get(uid); return w ? { address: w.address, shown: checksum(w.address), created: Number(w.created) } : null; }
  function createWallet(uid, who) {
    if (q.wallet.get(uid)) return { wallet: wallet(uid) };
    const k = newKey(), a = addressOf(k);
    q.walletIns.run(uid, a, enc(uid, k), now());
    k.fill(0);
    audit(uid, who, 'wallet', 'Agent wallet created: ' + checksum(a));
    return { wallet: wallet(uid), created: true };
  }

  /* ---------- settings ---------- */
  function settings(uid) {
    const r = q.setGet.get(uid);
    const s = Object.assign({}, DEFAULTS, r ? JSON.parse(r.json) : {});
    s.allow = (s.allow || []).map((x) => Object.assign({}, x, { active: Number(x.active_at) <= now() }));
    return s;
  }
  const clampUsd = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.round(Math.min(100_000, Math.max(0, n)) * 100) / 100 : d; };
  const money = (v) => '$' + Number(v).toFixed(2);
  function saveSettings(uid, b, who) {
    const cur = settings(uid), next = Object.assign({}, cur);
    if (b.daily_usd != null) next.daily_usd = clampUsd(b.daily_usd, cur.daily_usd);
    if (b.per_tx_usd != null) next.per_tx_usd = clampUsd(b.per_tx_usd, cur.per_tx_usd);
    if (b.wait_usd != null) next.wait_usd = clampUsd(b.wait_usd, cur.wait_usd);
    if (b.timelock_min != null) { const t = Math.round(Number(b.timelock_min)); if (!(t >= 1 && t <= 1440)) return bad('The timelock is 1 to 1440 minutes.'); next.timelock_min = t; }
    if (b.tolerance_pct != null) { const t = Number(b.tolerance_pct); if (!(t >= 0 && t <= 20)) return bad('The PROOF tolerance is 0 to 20%.'); next.tolerance_pct = t; }
    if (b.paused != null) next.paused = !!b.paused;
    if (Array.isArray(b.chains)) next.chains = Object.keys(NETWORKS).filter((c) => b.chains.includes(c));
    if (Array.isArray(b.allow)) {
      if (b.allow.length > MAX_ALLOW) return bad(`Up to ${MAX_ALLOW} allowed addresses.`);
      const old = new Map(cur.allow.map((x) => [x.address, x])), seen = new Set(), out = [];
      for (const x of b.allow) {
        if (!x || !isAddr(x.address)) return bad('Each allowed address must be a 0x… EVM address.');
        const a = String(x.address).toLowerCase();
        if (seen.has(a)) continue; seen.add(a);
        const label = String(x.label || '').replace(/[^\p{L}\p{N} ._@-]/gu, '').trim().slice(0, 40) || short(a);
        const was = old.get(a);
        // a new address becomes usable after a delay, so a stolen session cannot add an address and drain the wallet at once
        // optional per-address daily cap in USD (null = only the account caps apply)
        let cap = was && was.daily_usd != null ? was.daily_usd : null;
        if ('daily_usd' in x) cap = x.daily_usd === null || x.daily_usd === '' ? null : clampUsd(x.daily_usd, cap);
        out.push({ address: a, label, added: was ? was.added : now(), active_at: was ? was.active_at : now() + allowDelayMin * 60_000, daily_usd: cap });
      }
      next.allow = out;
    }
    const w = q.wallet.get(uid);
    if (w) next.allow = next.allow.filter((x) => x.address !== w.address);
    const store = Object.assign({}, next, { allow: next.allow.map(({ active, ...x }) => x) });
    q.setPut.run(uid, JSON.stringify(store), now());
    const added = next.allow.filter((x) => !cur.allow.some((y) => y.address === x.address));
    const removed = cur.allow.filter((x) => !next.allow.some((y) => y.address === x.address));
    const capUp = next.allow.filter((x) => { const o = cur.allow.find((y) => y.address === x.address); return o && o.daily_usd != null && (x.daily_usd == null || x.daily_usd > o.daily_usd); });
    const looser = next.daily_usd > cur.daily_usd || next.per_tx_usd > cur.per_tx_usd || next.wait_usd > cur.wait_usd || (cur.paused && !next.paused) || added.length || next.chains.length > cur.chains.length || capUp.length || next.timelock_min < cur.timelock_min || next.tolerance_pct > cur.tolerance_pct;
    const diff = [];
    for (const [k, n] of [['daily_usd', 'daily cap'], ['per_tx_usd', 'per-request cap'], ['wait_usd', 'review line']]) if (next[k] !== cur[k]) diff.push(`${n} ${money(cur[k])} → ${money(next[k])}`);
    if (next.timelock_min !== cur.timelock_min) diff.push(`timelock ${cur.timelock_min} → ${next.timelock_min} min`);
    if (next.tolerance_pct !== cur.tolerance_pct) diff.push(`PROOF tolerance ${cur.tolerance_pct} → ${next.tolerance_pct}%`);
    if (next.paused !== cur.paused) diff.push(next.paused ? 'PAUSED' : 'resumed');
    if (next.chains.join() !== cur.chains.join()) diff.push('networks: ' + (next.chains.map((c) => NETWORKS[c].name).join(', ') || 'none'));
    for (const x of added) diff.push(`allowed + ${x.label} ${x.address}${x.daily_usd != null ? ' (max ' + money(x.daily_usd) + '/day)' : ''}`);
    for (const x of removed) diff.push(`allowed − ${x.label} ${x.address}`);
    for (const x of next.allow) { const o = cur.allow.find((y) => y.address === x.address); if (o && o.daily_usd !== x.daily_usd) diff.push(`${x.label}: daily ${o.daily_usd == null ? 'no own cap' : money(o.daily_usd)} → ${x.daily_usd == null ? 'no own cap' : money(x.daily_usd)}`); }
    if (diff.length) audit(uid, who, looser ? 'settings · looser' : 'settings', diff.join('; '));
    if (looser && notify) notify.send(uid, 'rails.changed', { daily_usd: next.daily_usd, per_tx_usd: next.per_tx_usd, wait_usd: next.wait_usd, paused: next.paused, added: added.map((x) => x.label + ' ' + x.address).join(', ') }, true).catch(() => {});
    return { settings: settings(uid) };
  }

  /* ---------- chain access ---------- */
  const url = (c) => rpcOverrides[c] || NETWORKS[c].rpc;
  let rid = 0;
  async function rpc(c, method, params) {
    const r = await fetchImpl(url(c), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }), signal: AbortSignal.timeout(15_000) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(String(j.error.message || j.error.code).slice(0, 200)), { rpc: true });
    return j.result;
  }
  const hex = (n) => '0x' + BigInt(n).toString(16);
  async function valueMicro(asset, units, d) {
    if (COINS[asset] && COINS[asset].stable) return Number(units * 1_000_000n / pow10(d));
    const p = await price(asset);                       // median of Coinbase, Kraken, CoinGecko (cached 60 s)
    return Math.round(Number(units * 1_000_000n / pow10(d)) * p);
  }
  const balCache = new Map();
  async function balances(uid) {
    const w = q.wallet.get(uid); if (!w) return [];
    const c0 = balCache.get(uid); if (c0 && now() - c0.at < 15_000) return c0.v;
    const v = await Promise.all(Object.keys(NETWORKS).map(async (c) => {
      const n = NETWORKS[c], toks = Object.entries(n.assets).filter(([, x]) => x.token);
      try {
        const nat = BigInt(await rpc(c, 'eth_getBalance', [w.address, 'latest']));
        const items = [{ asset: NATIVE[c], amount: fmtUnits(nat, 18, 6), gas: true }];
        for (const [sym, x] of toks) { const r = await rpc(c, 'eth_call', [{ to: x.token, data: erc20.balanceOf(w.address) }, 'latest']); items.push({ asset: sym, amount: fmtUnits(BigInt(r && r !== '0x' ? r : '0x0'), x.dec, 4) }); }
        return { chain: c, name: n.name, items };
      } catch { return { chain: c, name: n.name, error: 'not available right now' }; }
    }));
    balCache.set(uid, { at: now(), v });
    return v;
  }

  /* ---------- normalize: what does this request actually do? ---------- */
  function normalize(b, uid) {
    const action = String(b.action || 'pay');
    const chain = String(b.chain || '').toLowerCase();
    if (!NETWORKS[chain]) return bad('Unknown network. Use one of: ' + Object.keys(NETWORKS).join(', ') + '.');
    const n = NETWORKS[chain];
    if (action === 'raw') {
      if (!isAddr(b.to)) return bad('"to" must be a 0x… address.');
      const to = String(b.to).toLowerCase(), data = String(b.data || '0x').toLowerCase();
      if (!/^0x([0-9a-f]{2})*$/.test(data) || data.length > 20_000) return bad('"data" must be 0x… hex.');
      let value; try { value = BigInt(String(b.value || '0')); } catch { return bad('"value" must be an integer in wei.'); }
      if (value < 0n) return bad('"value" must not be negative.');
      const tx = { to, value, data };
      const dc = decodeCall(data);
      if (dc && dc.method === 'none') {
        const sym = NATIVE[chain]; if (!n.assets[sym]) return { chain, tx, undecodable: `it sends ${sym}, which DELIRA does not handle on ${n.name}` };
        return { action: 'pay', chain, asset: sym, dec: 18, to, units: value, tx };
      }
      const tok = Object.entries(n.assets).find(([, x]) => x.token === to);
      if (!tok || !dc || dc.method === 'unknown') return { chain, tx, undecodable: dc && dc.selector ? `an unknown method ${dc.selector} on ${short(to)}` : `a call to ${short(to)} that DELIRA cannot read` };
      if (value > 0n) return { chain, tx, undecodable: `it sends ${NATIVE[chain]} and calls a contract at the same time` };
      if (dc.method === 'transfer') return { action: 'pay', chain, asset: tok[0], dec: tok[1].dec, to: dc.to, units: dc.units, tx };
      return { action: 'approve', chain, asset: tok[0], dec: tok[1].dec, to: dc.spender, units: dc.units, tx, increase: dc.method === 'increaseAllowance' };
    }
    if (action !== 'pay' && action !== 'approve') return bad('"action" is pay, approve or raw.');
    const asset = String(b.asset || '').toUpperCase(), a = n.assets[asset];
    if (!a) return bad(`${asset || 'This asset'} is not available on ${n.name}. Available: ${Object.keys(n.assets).join(', ')}.`);
    if (!isAddr(b.to)) return bad('"to" must be a 0x… address.');
    const to = String(b.to).toLowerCase();
    let units;
    if (action === 'approve' && /^(unlimited|max)$/i.test(String(b.amount))) units = MAXU;
    else { units = parseUnits(b.amount, a.dec); if (units == null || units <= 0n) return bad(`"amount" must be a positive number with up to ${a.dec} decimals, like "12.5".`); }
    if (action === 'approve' && !a.token) return bad('Only tokens can be approved.');
    const tx = a.token ? { to: a.token, value: 0n, data: action === 'pay' ? erc20.transfer(to, units) : erc20.approve(to, units) } : { to, value: units, data: '0x' };
    return { action, chain, asset, dec: a.dec, to, units, tx };
  }
  const unlimited = (u) => u > (MAXU >> 4n);
  const amountText = (nm) => unlimited(nm.units) ? 'UNLIMITED ' + nm.asset : fmtUnits(nm.units, nm.dec, 6) + ' ' + nm.asset;
  const dayStart = () => { const d = new Date(now()); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
  function allowEntry(s, a) { return s.allow.find((x) => x.address === a); }
  function lookalike(s, a) { return s.allow.find((x) => x.address !== a && x.address.slice(2, 6) === a.slice(2, 6) && x.address.slice(-4) === a.slice(-4)); }

  /* ---------- the five rails ---------- */
  async function check(uid, nm, b, s, w, selfId, keyId) {
    const out = [], name = (a) => { const e = allowEntry(s, a); return e ? `${e.label} (${short(a)})` : short(a); };
    let micro = 0;
    if (nm.action && !unlimited(nm.units)) {
      try { micro = await valueMicro(nm.asset, nm.units, nm.dec); }
      catch { return { checks: [{ rail: 'PROOF', result: 'stop', note: `No price for ${nm.asset} right now, so DELIRA cannot value this request. Try again in a minute.` }], micro }; }
    }
    const stop = (rail, note, extra) => { out.push(Object.assign({ rail, result: 'stop', note }, extra || {})); return { checks: out, micro }; };
    const pass = (rail, note, result = 'pass') => out.push({ rail, result, note });

    // PROOF
    if (!nm.action) pass('PROOF', 'Nothing to value: see PLAIN.', 'skip');
    else if (nm.action === 'approve') pass('PROOF', 'Nothing is paid now; the allowance itself is checked by LIMIT and PLAIN.');
    else {
      const p = b.proof && typeof b.proof === 'object' ? b.proof : {};
      const src = String(p.source || '').toLowerCase(), ref = String(p.ref || '').trim();
      if (!SOURCES.includes(src) || ref.length < 3) return stop('PROOF', `No source for ${amountText(nm)}. Attach where the amount came from (proof.source: invoice, quote, feed or contract, and proof.ref: the invoice number, quote link or feed name). No source, no signature.`);
      if (p.usd == null && src === 'feed') return stop('PROOF', 'A price-feed source must include the USD value it gave (proof.usd), so DELIRA can check it.');
      if (p.usd != null) {
        const claimed = Number(p.usd);
        if (!(claimed > 0)) return stop('PROOF', 'proof.usd must be a positive number.');
        const real = micro / 1e6, off = Math.abs(claimed - real) / Math.max(real, 1e-9) * 100;
        if (off > s.tolerance_pct) return stop('PROOF', `The source says $${claimed.toFixed(2)}, but ${amountText(nm)} is ${usd(micro)} right now (off by ${off.toFixed(1)}%, your tolerance is ${s.tolerance_pct}%).`);
        pass('PROOF', `Source: ${src} "${ref.slice(0, 80)}"; $${claimed.toFixed(2)} matches ${usd(micro)}.`);
      } else pass('PROOF', `Source: ${src} "${ref.slice(0, 80)}" (${amountText(nm)} ≈ ${usd(micro)}).`);
    }

    // LIMIT
    if (s.paused) return stop('LIMIT', 'The agent wallet is paused by the owner. Nothing moves until it is resumed.');
    if (!nm.action) pass('LIMIT', 'Nothing to count: see PLAIN.', 'skip');
    else if (unlimited(nm.units)) pass('LIMIT', 'An unlimited allowance has no number to count: see PLAIN.', 'skip');
    else {
      const capTx = Math.round(s.per_tx_usd * 1e6), capDay = Math.round(s.daily_usd * 1e6);
      if (micro > capTx) return stop('LIMIT', `${usd(micro)} is above the per-request cap of ${usd(capTx)}.`);
      const used = Number((selfId ? q.usedBut.get(uid, dayStart(), selfId) : q.used.get(uid, dayStart())).u);
      if (used + micro > capDay) return stop('LIMIT', `Daily cap ${usd(capDay)}: ${usd(used)} already used today (UTC), this request is ${usd(micro)}. The agent waits for you: raise the cap or try after 00:00 UTC.`);
      const extra = [];
      const kc = keyId ? keyCap(keyId) : null;
      if (kc != null) {
        const cap = Math.round(kc * 1e6), u = Number(q.usedKey.get(uid, keyId, dayStart(), selfId || '').u);
        if (u + micro > cap) return stop('LIMIT', `This API key has its own daily cap of ${usd(cap)}: ${usd(u)} already used by it today, this request is ${usd(micro)}.`);
        extra.push(`key ${usd(u + micro)} of ${usd(cap)}`);
      }
      const ae = allowEntry(s, nm.to);
      if (ae && ae.daily_usd != null) {
        const cap = Math.round(ae.daily_usd * 1e6), u = Number(q.usedAddr.get(uid, nm.to, dayStart(), selfId || '').u);
        if (u + micro > cap) return stop('LIMIT', `"${ae.label}" may receive at most ${usd(cap)} a day: ${usd(u)} already today, this request is ${usd(micro)}.`);
        extra.push(`${ae.label} ${usd(u + micro)} of ${usd(cap)}`);
      }
      pass('LIMIT', `${usd(micro)} of ${usd(capDay)} today (${usd(used)} used before)${extra.length ? '; ' + extra.join('; ') : ''}.`);
    }

    // ROUTE
    if (!s.chains.includes(nm.chain)) return stop('ROUTE', `${NETWORKS[nm.chain].name} is not on your list of networks.`);
    const target = nm.action ? nm.to : nm.tx.to;
    if (target === w.address) return stop('ROUTE', 'This sends to the agent wallet itself.');
    if (/^0x0{40}$/.test(target)) return stop('ROUTE', 'This sends to the zero address, where funds are lost.');
    const e = allowEntry(s, target);
    if (!e) {
      const like = lookalike(s, target);
      if (like) return stop('ROUTE', `${target} looks like your allowed "${like.label}" (${like.address}) but it is a different address. Refused.`);
      return stop('ROUTE', `${target} is not on your allowed list. If you trust it, add it in Settings → Agent wallet (it becomes usable ${allowDelayMin} min after you add it).`);
    }
    if (!e.active) return stop('ROUTE', `"${e.label}" was added recently and becomes usable at ${new Date(Number(e.active_at)).toISOString().slice(11, 16)} UTC.`);
    pass('ROUTE', `${nm.action === 'approve' ? 'Spender' : 'Recipient'} "${e.label}" is on your allowed list; ${NETWORKS[nm.chain].name} is allowed.`);

    // PLAIN
    if (!nm.action) return stop('PLAIN', `DELIRA cannot say what this transaction does in plain words (${nm.undecodable}), so it is not signed.`, { flags: ['unreadable'] });
    let plain;
    if (nm.action === 'pay') plain = `Send ${amountText(nm)} on ${NETWORKS[nm.chain].name} from the agent wallet to ${name(nm.to)} (about ${usd(micro)}).`;
    else plain = `Let ${name(nm.to)} spend ${unlimited(nm.units) ? 'an UNLIMITED amount of ' + nm.asset : 'up to ' + amountText(nm)} from the agent wallet on ${NETWORKS[nm.chain].name}${nm.increase ? ' (on top of what it may already spend)' : ''}.`;
    if (nm.action === 'approve' && unlimited(nm.units)) return stop('PLAIN', plain + ' An unlimited allowance lets the spender take everything, now or later. Not signed: approve an exact amount instead.', { plain, flags: ['unlimited approval'] });
    pass('PLAIN', plain); out[out.length - 1].plain = plain;

    // WAIT
    const memo = String(b.memo || '').trim();
    if (memo.length < 8 || memo.split(/\s+/).length < 2) return stop('WAIT', 'What is this for? Send it again with a memo that says who, what and why (for example "weekly price report from data-agent").', { question: true });
    if (micro >= Math.round(s.wait_usd * 1e6)) { out.push({ rail: 'WAIT', result: 'wait', note: `${usd(micro)} is at or above your review line of ${usd(Math.round(s.wait_usd * 1e6))}: it waits ${s.timelock_min} min. Approve it now or cancel it from the chat or settings.` }); return { checks: out, micro, plain }; }
    pass('WAIT', `Clear memo, below your review line of ${usd(Math.round(s.wait_usd * 1e6))}.`);
    return { checks: out, micro, plain };
  }

  function view(r) {
    if (!r) return null;
    const checks = r.checks ? JSON.parse(r.checks) : [];
    return {
      id: r.id, status: r.status, kind: r.kind, rail: r.rail || null, reason: r.reason || null, question: !!r.question, plain: r.plain || null,
      chain: r.chain, network: NETWORKS[r.chain] ? NETWORKS[r.chain].name : r.chain, asset: r.asset, to: r.to_addr,
      amount: r.units != null && r.dec != null ? (BigInt(r.units) > (MAXU >> 4n) ? 'unlimited' : fmtUnits(BigInt(r.units), Number(r.dec), 6)) : null,
      usd: (Number(r.usd) / 1e6).toFixed(2), memo: r.memo || '', checks, tx: r.tx || null,
      explorer: r.tx && (r.status === 'sent' || r.status === 'confirmed' || r.status === 'failed') ? EXPLORER[r.chain] + '/tx/' + r.tx : null,
      created: Number(r.created), release_at: r.release_at ? Number(r.release_at) : null, via: r.via || null,
      fee_bumps: Number(r.bumps || 0), callback: !!r.callback,
    };
  }

  // the main entry: an agent (or the owner, from the chat) asks DELIRA to move funds from the agent wallet
  // ctx: { keyId } when an agent asks with an API key
  function request(uid, b, via, ctx) { return locked(uid, () => request1(uid, b, via, ctx || {})); }
  async function request1(uid, b, via, ctx) {
    if (!b || typeof b !== 'object') return bad('Bad request.');
    let callback = null;
    if (b.callback_url != null && b.callback_url !== '') {
      if (!ctx.keyId || !hook) return bad('callback_url works only for requests made with an API key.');
      const e = hook.check(b.callback_url); if (e) return bad('callback_url: ' + e);
      callback = String(b.callback_url);
    }
    const w = q.wallet.get(uid);
    if (!w) return { error: 'No agent wallet yet. Create it in Settings → Agent wallet.', status: 409 };
    const idem = b.idempotency_key != null ? String(b.idempotency_key).slice(0, 80) : null;
    if (idem) { const ex = q.byIdem.get(uid, idem); if (ex) return { request: view(ex), repeated: true }; }
    const nm = normalize(b, uid);
    if (nm.error) return nm;
    const s = settings(uid);
    const r = await check(uid, nm, b, s, w, null, ctx.keyId || null);
    const last = r.checks[r.checks.length - 1];
    const status = last.result === 'stop' ? 'stopped' : last.result === 'wait' ? 'waiting' : 'queued';
    const out = { checks: r.checks, status, rail: last.result === 'pass' ? null : last.rail, reason: last.result === 'pass' ? null : last.note };
    if (b.dry_run) return { request: Object.assign({ dry_run: true, plain: r.plain || last.plain || null, usd: (r.micro / 1e6).toFixed(2) }, out) };
    const id = crypto.randomUUID(), t = now();
    try {
      q.ins.run(id, uid, idem, nm.action || 'raw', via || null, nm.chain, nm.asset || null, nm.to || nm.tx.to, nm.units != null ? nm.units.toString() : null, nm.dec ?? null,
        status === 'stopped' ? 0 : r.micro, String(b.memo || '').slice(0, 300), b.proof ? JSON.stringify(b.proof).slice(0, 1000) : null,
        status, out.rail, out.reason, last.question ? 1 : null, r.plain || last.plain || null, JSON.stringify(r.checks),
        nm.tx.to, nm.tx.value.toString(), nm.tx.data, t, status === 'waiting' ? t + s.timelock_min * 60_000 : null, t, ctx.keyId || null, callback);
    } catch (e) { if (idem && /UNIQUE/.test(e.message)) return { request: view(q.byIdem.get(uid, idem)), repeated: true }; throw e; }
    const v = view(q.get.get(id));
    if (notify) {
      if (status === 'waiting') notify.send(uid, 'rails.waiting', { id, plain: v.plain, usd: v.usd, minutes: s.timelock_min }, true).catch(() => {});
      else if (status === 'stopped') notify.emit(uid, 'rails.stopped', { id, rail: out.rail, reason: out.reason });
    }
    if (status === 'queued' || callback) kick();
    return { request: v };
  }

  // re-run the rails at execution time (settings may have changed while it waited); its own reservation is excluded
  async function recheck(r) {
    const w = q.wallet.get(r.uid), s = settings(r.uid);
    if (r.kind === 'withdraw') return null;
    const nm = normalize({ action: 'raw', chain: r.chain, to: r.tx_to, value: r.tx_value, data: r.tx_data }, r.uid);
    if (nm.error) return { rail: 'PLAIN', note: nm.error };
    const res = await check(r.uid, nm, { proof: r.proof ? JSON.parse(r.proof) : null, memo: r.memo }, s, w, r.id, r.key_id || null);
    const bad1 = res.checks.find((c) => c.result === 'stop' && c.rail !== 'PROOF');   // PROOF was checked at request time against the price then
    return bad1 ? { rail: bad1.rail, note: 'Changed while waiting: ' + bad1.note } : null;
  }

  function decide(uid, id, how, who) { return locked(uid, () => decide1(uid, id, how, who)); }
  async function decide1(uid, id, how, who) {
    const r = q.get.get(String(id));
    if (!r || r.uid !== uid) return { error: 'Request not found.', status: 404 };
    if (how === 'cancel') {
      if (r.status !== 'waiting' && r.status !== 'queued') return { error: `This request is ${r.status} and can no longer be cancelled.`, status: 409 };
      q.set.run('cancelled', null, 'Cancelled by the owner.', now(), r.id, r.status);
      audit(uid, who, 'cancelled', r.plain || r.id);
      return { request: view(q.get.get(r.id)) };
    }
    if (r.status !== 'waiting') return { error: `This request is ${r.status}, not waiting.`, status: 409 };
    const no = await recheck(r);
    if (no) { q.set.run('stopped', no.rail, no.note, now(), r.id, 'waiting'); return { request: view(q.get.get(r.id)) }; }
    q.set.run('queued', null, 'Approved early by the owner.', now(), r.id, 'waiting');
    audit(uid, who, 'approved', r.plain || r.id);
    kick();
    return { request: view(q.get.get(r.id)) };
  }

  // the owner takes funds back: to the wallet they signed in with, or to an active allowed address. No caps, no timelock.
  async function withdraw(uid, b, who) {
    const w = q.wallet.get(uid); if (!w) return { error: 'No agent wallet yet.', status: 409 };
    const chain = String(b.chain || ''), n = NETWORKS[chain]; if (!n) return bad('Unknown network.');
    const asset = String(b.asset || '').toUpperCase(), a = n.assets[asset]; if (!a) return bad(`${asset} is not available on ${n.name}.`);
    const own = uid.startsWith('evm:') ? uid.slice(4) : null, s = settings(uid);
    const to = b.to ? String(b.to).toLowerCase() : own;
    if (!to || !isAddr(to)) return bad('Choose where to send it: one of your active allowed addresses.');
    if (to !== own) { const e = allowEntry(s, to); if (!e || !e.active) return bad('Withdrawals go to the wallet you signed in with, or to an active allowed address.'); }
    let units;
    if (String(b.amount) === 'all') {
      if (a.token) units = BigInt(await rpc(chain, 'eth_call', [{ to: a.token, data: erc20.balanceOf(w.address) }, 'latest']) || '0x0');
      else {
        const bal = BigInt(await rpc(chain, 'eth_getBalance', [w.address, 'latest'])), f = await fees(chain);
        let gas = 21_000n; try { gas = BigInt(await rpc(chain, 'eth_estimateGas', [{ from: w.address, to, value: '0x1', data: '0x' }])); } catch { }
        // the executor adds 20% to the estimate; keep twice the fee, plus a small reserve for the L1 data fee on Base and Arbitrum
        units = bal - gas * 12n / 10n * 2n * (f.maxFeePerGas || f.gasPrice) - (chain === 'base' || chain === 'arbitrum' ? 20_000_000_000_000n : 0n);
      }
      if (units <= 0n) return bad(`Nothing to withdraw in ${asset} on ${n.name}.`);
    } else { units = parseUnits(b.amount, a.dec); if (units == null || units <= 0n) return bad('"amount" must be a positive number or "all".'); }
    const tx = a.token ? { to: a.token, value: 0n, data: erc20.transfer(to, units) } : { to, value: units, data: '0x' };
    const id = crypto.randomUUID(), t = now(), plain = `Withdraw ${fmtUnits(units, a.dec, 6)} ${asset} on ${n.name} to ${to === own ? 'your sign-in wallet' : allowEntry(s, to).label} (${short(to)}).`;
    q.ins.run(id, uid, null, 'withdraw', 'owner', chain, asset, to, units.toString(), a.dec, 0, 'owner withdrawal', null, 'queued', null, null, null, plain,
      JSON.stringify([{ rail: 'OWNER', result: 'pass', note: 'The owner moves funds back; caps and timelock do not apply.' }]), tx.to, tx.value.toString(), tx.data, t, null, t, null, null);
    audit(uid, who, 'withdrawal', plain);
    kick();
    return { request: view(q.get.get(id)) };
  }

  /* ---------- executor: sign, broadcast, confirm ---------- */
  async function fees(c) {
    if (c === 'bsc') return { type: 0, gasPrice: BigInt(await rpc(c, 'eth_gasPrice', [])) };
    const blk = await rpc(c, 'eth_getBlockByNumber', ['latest', false]);
    const base = BigInt(blk.baseFeePerGas || '0x0');
    let prio; try { prio = BigInt(await rpc(c, 'eth_maxPriorityFeePerGas', [])); } catch { prio = c === 'polygon' ? 30_000_000_000n : 1_000_000n; }
    if (c === 'polygon' && prio < 30_000_000_000n) prio = 30_000_000_000n;
    return { type: 2, maxPriorityFeePerGas: prio, maxFeePerGas: base * 2n + prio };
  }
  const fail = (r, note) => { q.set.run('failed', 'NETWORK', note, now(), r.id, r.status); log('rails fail', r.id, note); if (notify) notify.emit(r.uid, 'rails.failed', { id: r.id, reason: note }); };
  async function execute(r) {
    const w = q.wallet.get(r.uid), c = r.chain, value = BigInt(r.tx_value || '0');
    if (r.status === 'queued') {
      if (r.kind !== 'withdraw') { const no = await recheck(r); if (no) { q.set.run('stopped', no.rail, no.note, now(), r.id, 'queued'); return; } }
      const f = await fees(c);
      let gas;
      try { gas = BigInt(await rpc(c, 'eth_estimateGas', [{ from: w.address, to: r.tx_to, value: hex(value), data: r.tx_data }])) * 12n / 10n; }
      catch (e) { return fail(r, 'The network says this would fail: ' + e.message); }
      if (gas > 1_000_000n) return fail(r, 'This needs an unusual amount of gas; not sent.');
      const nat = BigInt(await rpc(c, 'eth_getBalance', [w.address, 'pending'])), cost = gas * (f.maxFeePerGas || f.gasPrice);
      if (nat < value + cost) return fail(r, `Not enough ${NATIVE[c]} in the agent wallet on ${NETWORKS[c].name} for this and the network fee (needs about ${fmtUnits(value + cost, 18, 6)} ${NATIVE[c]}).`);
      // never below what DELIRA itself already signed and sent from this wallet: public RPCs can lag behind
      const mine = q.lastNonce.get(r.uid, c).n;
      const nonce = Math.max(Number(BigInt(await rpc(c, 'eth_getTransactionCount', [w.address, 'pending']))), mine == null ? 0 : Number(mine) + 1);
      const k = dec(r.uid, w.enc);
      let s;
      try { s = await signTx(Object.assign({ chainId: NETWORKS[c].chainId, nonce, gas, to: r.tx_to, value, data: r.tx_data }, f), k); } finally { k.fill(0); }
      if (q.signed.run(s.raw, s.hash, nonce, now(), r.id).changes !== 1) return;   // cancelled meanwhile
      q.fees.run(JSON.stringify(feeJson(f, gas)), r.id);
      r = q.get.get(r.id);
    }
    if (!live) return;
    try { await rpc(c, 'eth_sendRawTransaction', [r.raw]); }
    catch (e) {
      const known = /already known|known transaction|already imported|ALREADY_EXISTS/i.test(e.message);
      if (!known) {
        let seen = null; try { seen = await rpc(c, 'eth_getTransactionByHash', [r.tx]); } catch { }
        if (!seen) {
          if (/nonce too low|replacement|underpriced|insufficient funds/i.test(e.message) || now() - Number(r.updated) > 10 * 60_000) return fail(r, 'The network refused it: ' + e.message);
          return;   // keep "signed": the same signed transaction is sent again on the next tick
        }
      }
    }
    q.sentOk.run(now(), now(), r.id);
    if (notify) notify.emit(r.uid, 'rails.sent', { id: r.id, plain: r.plain, tx: r.tx, explorer: EXPLORER[c] + '/tx/' + r.tx });
  }
  const feeJson = (f, gas) => ({ type: f.type, gas: String(gas), gasPrice: f.gasPrice != null ? String(f.gasPrice) : undefined, maxFeePerGas: f.maxFeePerGas != null ? String(f.maxFeePerGas) : undefined, maxPriorityFeePerGas: f.maxPriorityFeePerGas != null ? String(f.maxPriorityFeePerGas) : undefined });
  const up = (a, b) => (a > b ? a : b);
  // a sent transaction without a receipt after bumpAfterMin (×2, ×3 …): sign the same nonce again with fees at least 25% higher (max 3 times)
  async function bump(r) {
    const c = r.chain, w = q.wallet.get(r.uid), old = JSON.parse(r.fees);
    if (Number(BigInt(await rpc(c, 'eth_getTransactionCount', [w.address, 'latest']))) > Number(r.nonce)) return;   // that nonce is already used: a receipt is coming
    const cur = await fees(c), gas = BigInt(old.gas), x = (v) => BigInt(v) * 125n / 100n + 1n;
    const nf = old.type === 0 ? { type: 0, gasPrice: up(cur.gasPrice, x(old.gasPrice)) }
      : { type: 2, maxPriorityFeePerGas: up(cur.maxPriorityFeePerGas, x(old.maxPriorityFeePerGas)), maxFeePerGas: up(cur.maxFeePerGas, x(old.maxFeePerGas)) };
    const value = BigInt(r.tx_value || '0'), nat = BigInt(await rpc(c, 'eth_getBalance', [w.address, 'latest']));
    if (nat < value + gas * (nf.maxFeePerGas || nf.gasPrice)) { log('rails bump: not enough for the higher fee', r.id); return; }
    const k = dec(r.uid, w.enc);
    let sg; try { sg = await signTx(Object.assign({ chainId: NETWORKS[c].chainId, nonce: Number(r.nonce), gas, to: r.tx_to, value, data: r.tx_data }, nf), k); } finally { k.fill(0); }
    const hashes = JSON.parse(r.hashes || '[]').concat([r.tx]);
    if (q.bumped.run(sg.raw, sg.hash, JSON.stringify(feeJson(nf, gas)), JSON.stringify(hashes), now(), now(), r.id).changes !== 1) return;
    log('rails bump', r.id, 'fee raised', r.bumps + 1);
    try { await rpc(c, 'eth_sendRawTransaction', [sg.raw]); } catch (e) { log('rails bump send', r.id, e.message); }   // the next tick re-checks every hash
  }
  async function confirm(r) {
    const all = [r.tx].concat(JSON.parse(r.hashes || '[]'));   // after a fee bump, any of them may be the one that gets mined
    let rc = null, hit = r.tx;
    for (const hsh of all) { let x = null; try { x = await rpc(r.chain, 'eth_getTransactionReceipt', [hsh]); } catch { return; } if (x && x.blockNumber) { rc = x; hit = hsh; break; } }
    if (rc && hit !== r.tx) q.mined.run(hit, r.id);
    if (rc && rc.blockNumber) { q.set.run(rc.status === '0x1' ? 'confirmed' : 'failed', null, rc.status === '0x1' ? null : 'It was included but reverted on chain (nothing moved except the network fee).', now(), r.id, 'sent'); return; }
    const since = Number(r.bumped_at || r.sent_at || r.updated);
    if (live && r.fees && Number(r.bumps) < 3 && now() - since > bumpAfterMin * 60_000 * (Number(r.bumps) + 1)) { try { await bump(r); } catch (e) { log('rails bump', r.id, e.message); } return; }
    if (now() - Number(r.sent_at || r.updated) > 2 * 3_600_000) {
      let seen = false; for (const hsh of all) { try { if (await rpc(r.chain, 'eth_getTransactionByHash', [hsh])) seen = true; } catch { return; } }
      if (!seen) { fail(r, 'It was dropped by the network and never included.'); return; }
    }
    q.touch.run(now(), r.id);
  }
  async function callbacks() {
    const due = q.cbDue.all(now());
    await Promise.allSettled(due.map(async (r) => {
      const sec = r.key_id ? keySecret(r.key_id) : null;
      if (!sec) { q.cbOk.run(r.status, r.id); return; }   // the key was revoked: nobody to tell
      try { await hook.post(r.callback, sec, { event: 'rails.request', at: new Date(now()).toISOString(), data: view(r) }); q.cbOk.run(r.status, r.id); }
      catch (e) {
        const n = Number(r.cb_tries) + 1;
        if (n >= 6) { q.cbFail.run(0, null, r.status, r.id); log('rails callback gave up', r.id, e.message); }   // give up on this status; the next change tries again
        else q.cbFail.run(n, now() + 30_000 * 2 ** (n - 1), r.cb_status, r.id);
      }
    }));
  }
  let busy = false, again = false;
  async function tick() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      for (const r of q.due.all(now())) {
        const no = await recheck(r).catch((e) => ({ rail: 'LIMIT', note: 'Could not re-check: ' + e.message }));
        if (no) q.set.run('stopped', no.rail, no.note, now(), r.id, 'waiting'); else q.set.run('queued', null, 'Timelock passed.', now(), r.id, 'waiting');
      }
      const done = new Set();   // one transaction per chain per tick keeps nonces simple
      // operator halt (RAILS_HALT=1): nothing new is signed; what was already sent is still followed to its receipt
      for (const r of halted ? [] : q.work.all()) { const k = r.chain + r.uid; if (done.has(k)) continue; done.add(k); try { await execute(r); } catch (e) { log('rails exec', r.id, e.message); } }
      for (const r of q.sent.all(now() - 10_000)) await confirm(r);
      if (hook) await callbacks();
    } finally { busy = false; if (again) { again = false; setTimeout(tick, 50); } }
  }
  function kick() { setTimeout(() => tick().catch((e) => log('rails tick', e.message)), 10); }

  function overview(uid) {
    const w = wallet(uid), s = settings(uid);
    return { wallet: w, settings: s, defaults: DEFAULTS, rails: RAILS, networks: Object.entries(NETWORKS).map(([id, n]) => ({ id, name: n.name, gas: NATIVE[id], assets: Object.keys(n.assets) })),
      used_today: (Number(q.used.get(uid, dayStart()).u) / 1e6).toFixed(2), waiting: Number(q.pending.get(uid).n), allow_delay_min: allowDelayMin, live, halted,
      requests: q.mine.all(uid, 50).map(view), audit: q.audList.all(uid, 40).map((a) => ({ at: Number(a.at), who: a.who, what: a.what, detail: a.detail })) };
  }
  return { wallet, createWallet, settings, saveSettings, balances, request, decide, withdraw, overview, tick, get: (uid, id) => { const r = q.get.get(String(id)); return r && r.uid === uid ? view(r) : null; },
    pendingCount: (uid) => Number(q.pending.get(uid).n), audit, _normalize: normalize, _dec: dec };
}
