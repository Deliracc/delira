// node engine/test/rails-test.mjs — the rails engine with a fake chain: agent wallet keys, the five rails in order,
// waiting/approve/cancel, signing + broadcast + confirmation, idempotency, re-check after waiting, owner withdrawals.
import crypto from 'node:crypto';
import { openDb } from '../lib/db.mjs';
import { makeKeys } from '../lib/keys.mjs';
import { makeMcp } from '../lib/mcp.mjs';
import { makeRails } from '../lib/rails.mjs';
import { signTx, addressOf, rlp, decodeCall, erc20 } from '../lib/evm.mjs';
import { NETWORKS } from '../lib/networks.mjs';
import { keccak256 } from '../lib/keccak.mjs';
import { Signature } from '../lib/secp256k1.js';

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log('FAIL', name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- signing: EIP-155 spec vector, type 2 round trip ---------- */
function unrlp(b, i = 0) {
  const p = b[i];
  if (p < 0x80) return [Buffer.from([p]), i + 1];
  if (p < 0xb8) return [b.subarray(i + 1, i + 1 + p - 0x80), i + 1 + p - 0x80];
  if (p < 0xc0) { const ll = p - 0xb7, l = parseInt(b.subarray(i + 1, i + 1 + ll).toString('hex'), 16); return [b.subarray(i + 1 + ll, i + 1 + ll + l), i + 1 + ll + l]; }
  let l, s; if (p < 0xf8) { l = p - 0xc0; s = i + 1; } else { const ll = p - 0xf7; l = parseInt(b.subarray(i + 1, i + 1 + ll).toString('hex'), 16); s = i + 1 + ll; }
  const out = []; let j = s; while (j < s + l) { const [x, nj] = unrlp(b, j); out.push(x); j = nj; } return [out, s + l];
}
const big = (b) => BigInt('0x' + (Buffer.from(b).toString('hex') || '0'));
function senderOf(raw) {
  const b = Buffer.from(raw.slice(2), 'hex');
  if (b[0] !== 2) return null;
  const [f] = unrlp(b, 1);
  const hash = keccak256(Buffer.concat([Buffer.from([2]), rlp(f.slice(0, 9))]));
  const pub = new Signature(big(f[10]), big(f[11])).addRecoveryBit(Number(big(f[9]))).recoverPublicKey(hash.toString('hex')).toRawBytes(false);
  return { from: '0x' + keccak256(Buffer.from(pub).subarray(1)).subarray(12).toString('hex'), chainId: Number(big(f[0])), nonce: Number(big(f[1])), prio: big(f[2]), maxFee: big(f[3]), to: '0x' + Buffer.from(f[5]).toString('hex'), value: big(f[6]), data: '0x' + Buffer.from(f[7]).toString('hex') };
}
{
  const priv = Buffer.alloc(32, 0x46);
  const r = await signTx({ type: 0, chainId: 1, nonce: 9, gasPrice: 20000000000n, gas: 21000, to: '0x3535353535353535353535353535353535353535', value: 10n ** 18n }, priv);
  ok(r.raw === '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83', 'legacy tx matches the EIP-155 spec vector');
  ok(addressOf(priv) === '0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f', 'address from key');
  const t2 = await signTx({ type: 2, chainId: 8453, nonce: 3, gas: 60000n, maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000_000n, to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', value: 0n, data: erc20.transfer('0x' + '11'.repeat(20), 5_000_000n) }, priv);
  const s = senderOf(t2.raw);
  ok(s && s.from === addressOf(priv) && s.chainId === 8453 && s.nonce === 3, 'type 2 signature recovers to the wallet');
  ok(t2.hash === '0x' + keccak256(Buffer.from(t2.raw.slice(2), 'hex')).toString('hex'), 'tx hash = keccak(raw)');
  const d = decodeCall(erc20.approve('0x' + '22'.repeat(20), (1n << 256n) - 1n));
  ok(d.method === 'approve' && d.units === (1n << 256n) - 1n, 'approve calldata decoded');
  ok(decodeCall('0x12345678' + '0'.repeat(128)).method === 'unknown' && decodeCall('0xa9059cbb' + 'f'.repeat(128)).method === 'unknown', 'unknown / dirty calldata not decoded');
}

/* ---------- a fake chain ---------- */
const USDC = NETWORKS.base.assets.USDC.token;
const chain = { nonce: {}, native: {}, token: {}, sent: [], receipts: {}, refuse: null, estimateFail: false, lag: false, latest: {} };
const rpcOverrides = {}; for (const c of Object.keys(NETWORKS)) rpcOverrides[c] = 'rpc://' + c;
async function fakeFetch(url, opts) {
  const c = url.slice(6), j = JSON.parse(opts.body), p = j.params || [];
  const res = (result) => ({ json: async () => ({ jsonrpc: '2.0', id: j.id, result }) });
  const err = (message) => ({ json: async () => ({ jsonrpc: '2.0', id: j.id, error: { code: -32000, message } }) });
  switch (j.method) {
    case 'eth_getBalance': return res('0x' + (chain.native[c + p[0]] || 0n).toString(16));
    case 'eth_call': { const a = '0x' + p[0].data.slice(-40); return res('0x' + (chain.token[c + p[0].to + a] || 0n).toString(16).padStart(64, '0')); }
    case 'eth_getTransactionCount': if (p[1] === 'latest' && chain.latest[c + p[0]] != null) return res('0x' + chain.latest[c + p[0]].toString(16));
      return res('0x' + (chain.lag ? 0 : chain.nonce[c + p[0]] || 0).toString(16));
    case 'eth_getBlockByNumber': return res({ number: '0x10', baseFeePerGas: '0x3b9aca00' });
    case 'eth_maxPriorityFeePerGas': return res('0x5f5e100');
    case 'eth_gasPrice': return res('0x3b9aca00');
    case 'eth_estimateGas': return chain.estimateFail ? err('execution reverted: transfer amount exceeds balance') : res('0xc350');
    case 'eth_sendRawTransaction': {
      if (chain.refuse) return err(chain.refuse);
      const s = senderOf(p[0]); chain.sent.push(Object.assign({ chain: c, raw: p[0] }, s));
      chain.nonce[c + s.from] = (chain.nonce[c + s.from] || 0) + 1;
      return res('0x' + keccak256(Buffer.from(p[0].slice(2), 'hex')).toString('hex'));
    }
    case 'eth_getTransactionReceipt': return res(chain.receipts[p[0]] || null);
    case 'eth_getTransactionByHash': return res(null);
    default: return err('unsupported ' + j.method);
  }
}

let T = Date.UTC(2026, 10, 20, 12, 0, 0);
const now = () => T;
const db = openDb(':memory:'), notes = [];
const notify = { send: async (uid, ev, d) => { notes.push(ev); return {}; }, emit: (uid, ev) => notes.push(ev) };
const R = makeRails({ db, secret: 'x'.repeat(40), price: async (s) => (s === 'ETH' ? 3000 : 600), rpcOverrides, fetchImpl: fakeFetch, now, notify, allowDelayMin: 10 });
const U = 'evm:0x' + 'ab'.repeat(20), G = 'google:123';
const VENDOR = '0x' + '5a'.repeat(19) + '01', LIKE = '0x5a5a' + '00'.repeat(16) + '5a01', OTHER = '0x' + '77'.repeat(20);
const pay = (x) => Object.assign({ action: 'pay', chain: 'base', asset: 'USDC', to: VENDOR, amount: '1.5', memo: 'weekly price report from data-agent', proof: { source: 'invoice', ref: 'INV-1042', usd: 1.5 } }, x);
const stopAt = async (b, rail, re, uid = U) => { const r = await R.request(uid, b); const v = r.request; ok(v && v.status === 'stopped' && v.rail === rail && (!re || re.test(v.reason)), `stopped by ${rail}${re ? ' ' + re : ''} (got ${v ? v.status + ' ' + v.rail + ': ' + v.reason : JSON.stringify(r)})`); return v; };

/* ---------- wallet + settings ---------- */
ok((await R.request(U, pay())).status === 409, 'no wallet yet → 409');
const w = R.createWallet(U).wallet;
ok(/^0x[0-9a-f]{40}$/.test(w.address) && R.createWallet(U).wallet.address === w.address, 'one agent wallet per account');
const row = db.q('SELECT * FROM agent_wallets WHERE uid = ?').get(U);
ok(addressOf(R._dec(U, row.enc)) === w.address, 'stored key decrypts to the wallet');
let wrong = false; try { R._dec(G, row.enc); } catch { wrong = true; }
ok(wrong, 'the key is bound to its account (AAD)');
ok(!JSON.stringify(row).includes(R._dec(U, row.enc).toString('hex')), 'plaintext key is not stored');
ok(R.saveSettings(U, { allow: [{ address: 'nope' }] }).error, 'bad allowed address refused');
let st = R.saveSettings(U, { allow: [{ address: VENDOR, label: 'data-agent <x>' }, { address: w.address }] }).settings;
ok(st.allow.length === 1 && st.allow[0].label === 'data-agent x' && !st.allow[0].active, 'new allowed address waits, own wallet dropped, label cleaned');
ok(notes.includes('rails.changed'), 'loosening settings notifies the owner');
await stopAt(pay(), 'ROUTE', /becomes usable/);
T += 11 * 60_000;
ok(R.settings(U).allow[0].active, 'allowed address active after the delay');
R.saveSettings(U, { allow: [{ address: VENDOR, label: 'data-agent' }] });
ok(R.settings(U).allow[0].active, 're-saving keeps the original activation time');

/* ---------- the rails in order ---------- */
await stopAt(pay({ proof: null }), 'PROOF', /No source/);
await stopAt(pay({ proof: { source: 'invoice', ref: 'INV-1', usd: 15 } }), 'PROOF', /source says \$15\.00/);
await stopAt(pay({ proof: { source: 'feed', ref: 'coingecko' } }), 'PROOF', /must include the USD value/);
await stopAt(pay({ amount: '6', proof: { source: 'invoice', ref: 'INV-9' } }), 'LIMIT', /per-request cap/);
await stopAt(pay({ to: OTHER }), 'ROUTE', /not on your allowed list/);
await stopAt(pay({ to: LIKE }), 'ROUTE', /looks like your allowed "data-agent"/);
await stopAt(pay({ to: w.address }), 'ROUTE', /agent wallet itself/);
await stopAt({ action: 'raw', chain: 'base', to: USDC, data: '0xdeadbeef' + '0'.repeat(128), memo: 'do the thing please' }, 'ROUTE', /not on your allowed list/);
R.saveSettings(U, { allow: [{ address: VENDOR, label: 'data-agent' }, { address: USDC, label: 'USDC contract' }] }); T += 11 * 60_000;
await stopAt({ action: 'raw', chain: 'base', to: USDC, data: '0xdeadbeef' + '0'.repeat(128), memo: 'do the thing please' }, 'PLAIN', /unknown method 0xdeadbeef/);
await stopAt({ action: 'approve', chain: 'base', asset: 'USDC', to: VENDOR, amount: 'unlimited', memo: 'let data-agent pull fees' }, 'PLAIN', /UNLIMITED/);
await stopAt({ action: 'raw', chain: 'base', to: USDC, value: '1', data: erc20.transfer(VENDOR, 1n), memo: 'pay data-agent now' }, 'PLAIN', /at the same time/);
const q1 = await stopAt(pay({ memo: 'pay' }), 'WAIT', /What is this for/);
ok(q1.question === true, 'WAIT returns a question');
ok((await R.request(U, pay({ chain: 'polygon', asset: 'POL' }))).status === 400, 'unsupported asset is a 400, not a rail');
const dry = (await R.request(U, pay({ dry_run: true }))).request;
ok(dry.dry_run && dry.status === 'queued' && /Send 1\.5 USDC on Base/.test(dry.plain) && db.q('SELECT COUNT(*) n FROM rails_requests WHERE status = \'queued\'').get().n === 0, 'dry run answers without saving');

/* ---------- pass → sign → broadcast → confirm ---------- */
chain.native['base' + w.address] = 10n ** 16n; chain.token['base' + USDC + w.address] = 100_000_000n;
const a1 = (await R.request(U, pay({ idempotency_key: 'job-1' }))).request;
ok(a1.status === 'queued' && a1.checks.map((c) => c.rail).join() === 'PROOF,LIMIT,ROUTE,PLAIN,WAIT' && a1.checks.every((c) => c.result === 'pass'), 'all five rails pass in order');
ok((await R.request(U, pay({ idempotency_key: 'job-1' }))).request.id === a1.id, 'same idempotency key → same request');
await R.tick();
const s1 = chain.sent[0];
ok(chain.sent.length === 1 && s1.from === w.address && s1.to === USDC && s1.data === erc20.transfer(VENDOR, 1_500_000n) && s1.chainId === 8453, 'signed by the agent wallet: USDC transfer to the vendor on Base');
let g1 = R.get(U, a1.id);
ok(g1.status === 'sent' && g1.tx && /basescan\.org\/tx\//.test(g1.explorer), 'status sent with an explorer link');
ok(notes.includes('rails.sent'), 'owner notified when sent');
chain.receipts[g1.tx] = { blockNumber: '0x11', status: '0x1' };
T += 20_000; await R.tick();
ok(R.get(U, a1.id).status === 'confirmed', 'confirmed after the receipt');
ok((await R.request(U, pay({ idempotency_key: 'job-1' }))).request.status === 'confirmed', 'repeat of a finished job does not pay twice');

/* ---------- WAIT timelock, approve, cancel, re-check ---------- */
R.saveSettings(U, { wait_usd: 2, timelock_min: 15 });
const wt = (await R.request(U, pay({ amount: '2.5', proof: { source: 'quote', ref: 'q-77', usd: 2.5 } }))).request;
ok(wt.status === 'waiting' && wt.rail === 'WAIT' && wt.release_at === T + 15 * 60_000 && notes.includes('rails.waiting'), 'above the review line → waits 15 min, owner notified');
ok(R.pendingCount(U) === 1, 'waiting count for the chat badge');
await stopAt(pay({ amount: '1.5', proof: { source: 'invoice', ref: 'INV-3', usd: 1.5 } }), 'LIMIT', /already used today/);   // 1.5 sent + 2.5 waiting of $5
ok((await R.decide(G, wt.id, 'approve')).status === 404, 'other accounts cannot approve');
ok((await R.decide(U, wt.id, 'approve')).request.status === 'queued', 'owner approves early');
await R.tick();
ok(R.get(U, wt.id).status === 'sent' && chain.sent.length === 2 && chain.sent[1].nonce === 1, 'approved request sent with the next nonce');
const wt3 = (await R.request(U, pay({ amount: '1', proof: { source: 'invoice', ref: 'INV-4', usd: 1 }, memo: 'second report from data-agent' }))).request;
ok(wt3.status === 'queued', 'small one fits exactly into the cap');
R.saveSettings(U, { paused: true });
await R.tick();
ok(R.get(U, wt3.id).status === 'stopped' && /paused/.test(R.get(U, wt3.id).reason), 'pausing stops queued requests before signing');
R.saveSettings(U, { paused: false, daily_usd: 50, per_tx_usd: 50 });
const wc = (await R.request(U, pay({ amount: '4', proof: { source: 'invoice', ref: 'INV-c', usd: 4 } }))).request;
ok(wc.status === 'waiting' && (await R.decide(U, wc.id, 'cancel')).request.status === 'cancelled' && (await R.decide(U, wc.id, 'approve')).status === 409, 'owner cancels; a cancelled request cannot be approved');
const wt4 = (await R.request(U, pay({ amount: '3', proof: { source: 'invoice', ref: 'INV-5', usd: 3 } }))).request;
R.saveSettings(U, { allow: [{ address: USDC, label: 'USDC contract' }] });
T += 16 * 60_000; await R.tick();
ok(R.get(U, wt4.id).status === 'stopped' && /Changed while waiting/.test(R.get(U, wt4.id).reason), 'timelock passes but the address was removed → stopped');

/* ---------- executor failures ---------- */
R.saveSettings(U, { allow: [{ address: VENDOR, label: 'data-agent' }, { address: USDC, label: 'USDC contract' }] }); T += 11 * 60_000;
chain.estimateFail = true;
const f1 = (await R.request(U, pay({ amount: '1', proof: { source: 'invoice', ref: 'INV-6', usd: 1 } }))).request;
await R.tick();
ok(R.get(U, f1.id).status === 'failed' && /would fail/.test(R.get(U, f1.id).reason) && notes.includes('rails.failed'), 'a call the network rejects is not sent');
chain.estimateFail = false; chain.native['base' + w.address] = 0n;
const f2 = (await R.request(U, pay({ amount: '1', proof: { source: 'invoice', ref: 'INV-7', usd: 1 } }))).request;
await R.tick();
ok(R.get(U, f2.id).status === 'failed' && /Not enough ETH/.test(R.get(U, f2.id).reason), 'no gas → failed with a clear reason');
chain.native['base' + w.address] = 10n ** 16n; chain.refuse = 'connection reset';
const f3 = (await R.request(U, pay({ amount: '1', proof: { source: 'invoice', ref: 'INV-8', usd: 1 } }))).request;
await R.tick();
ok(R.get(U, f3.id).status === 'queued' || db.q('SELECT status FROM rails_requests WHERE id = ?').get(f3.id).status === 'signed', 'transient RPC error keeps the signed tx');
chain.refuse = null; await R.tick();
ok(R.get(U, f3.id).status === 'sent' && chain.sent.filter((x) => x.nonce === 2).length === 1, 'the same signed tx is sent on the next tick (no double spend)');

/* ---------- native ETH, approve, raw transfer ---------- */
chain.native['base' + w.address] = 10n ** 17n;
const e1 = (await R.request(U, { action: 'pay', chain: 'base', asset: 'ETH', to: VENDOR, amount: '0.0005', memo: 'gas top-up for data-agent', proof: { source: 'quote', ref: 'ops', usd: 1.5 } })).request;
ok(e1.status === 'queued' && e1.usd === '1.50', 'ETH valued at the median price');
await R.tick();
ok(chain.sent.at(-1).value === 5n * 10n ** 14n && chain.sent.at(-1).to === VENDOR, 'native transfer signed');
const ap = (await R.request(U, { action: 'approve', chain: 'base', asset: 'USDC', to: VENDOR, amount: '1.5', memo: 'allow data-agent to bill monthly' })).request;
ok(ap.status === 'queued' && /Let data-agent .* spend up to 1.5 USDC/.test(ap.plain), 'limited approval passes with a plain sentence');
const rw = (await R.request(U, { action: 'raw', chain: 'base', to: USDC, data: erc20.transfer(VENDOR, 1_000_000n), memo: 'raw transfer from agent sdk', proof: { source: 'invoice', ref: 'INV-9' } })).request;
ok(rw.status === 'queued' && rw.kind === 'pay' && rw.amount === '1', 'raw ERC-20 transfer decoded into a payment');

/* ---------- withdrawals ---------- */
const wd = await R.withdraw(U, { chain: 'base', asset: 'USDC', amount: 'all' });
ok(wd.request && wd.request.to === U.slice(4) && wd.request.kind === 'withdraw', 'withdraw goes to the sign-in wallet');
ok((await R.withdraw(U, { chain: 'base', asset: 'USDC', amount: '1', to: OTHER })).error, 'withdraw to a random address refused');
R.createWallet(G);
ok((await R.withdraw(G, { chain: 'base', asset: 'USDC', amount: '1' })).error, 'Google account needs an allowed address to withdraw');
const ov = R.overview(U);
ok(ov.wallet.address === w.address && ov.requests.length > 10 && ov.settings.daily_usd === 50, 'overview for settings');

/* ---------- hardening ---------- */
// parallel requests of one account are checked one after another: they cannot all fit under the same daily cap
const P = 'evm:0x' + 'cd'.repeat(20); const wp = R.createWallet(P).wallet;
R.saveSettings(P, { daily_usd: 5, per_tx_usd: 5, wait_usd: 100, allow: [{ address: VENDOR, label: 'data-agent' }] }); T += 11 * 60_000;
const par = await Promise.all([1, 2, 3, 4, 5].map((i) => R.request(P, pay({ amount: '2', proof: { source: 'invoice', ref: 'PAR-' + i, usd: 2 } }))));
ok(par.filter((x) => x.request.status === 'queued').length === 2 && par.filter((x) => x.request.rail === 'LIMIT').length === 3, 'five parallel $2 requests under a $5 cap: two pass, three stop at LIMIT');
// a lagging RPC reports an old nonce: DELIRA never signs below what it already sent
chain.native['base' + wp.address] = 10n ** 16n; chain.token['base' + USDC + wp.address] = 100_000_000n;
await R.tick(); await R.tick();
const pn = chain.sent.filter((x) => x.from === wp.address).map((x) => x.nonce);
ok(pn.join() === '0,1', 'two payments, nonces 0 and 1 (got ' + pn.join() + ')');
chain.lag = true; R.saveSettings(P, { daily_usd: 50, per_tx_usd: 50 });
await R.request(P, pay({ amount: '1', proof: { source: 'invoice', ref: 'LAG-1', usd: 1 } })); await R.tick();
chain.lag = false;
ok(chain.sent.filter((x) => x.from === wp.address).at(-1).nonce === 2, 'with a lagging RPC the next nonce is still 2');
// withdraw all of the native coin keeps the fee
chain.native['base' + wp.address] = 10n ** 16n;
const wa = (await R.withdraw(P, { chain: 'base', asset: 'ETH', amount: 'all' })).request;
const wun = BigInt(db.q('SELECT units FROM rails_requests WHERE id = ?').get(wa.id).units);
ok(wun > 0n && wun < 10n ** 16n - 20_000_000_000_000n, 'withdraw all ETH leaves the fee and the L2 reserve');
// operator halt: requests are still checked, nothing new is signed
const H = makeRails({ db, secret: 'x'.repeat(40), price: async () => 3000, rpcOverrides, fetchImpl: fakeFetch, now, allowDelayMin: 10, halted: true });
const before = chain.sent.length;
const hr = (await H.request(P, pay({ amount: '1', proof: { source: 'invoice', ref: 'HALT-1', usd: 1 } }))).request;
await H.tick();
ok(hr.status === 'queued' && chain.sent.length === before && H.overview(P).halted === true, 'halted: checked and kept, not signed');
db.q("UPDATE rails_requests SET status = 'cancelled' WHERE id = ?").run(hr.id);
// API keys: a key may pay only when the owner turned it on
db.db.exec("CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, uid TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER, revoked INTEGER NOT NULL DEFAULT 0)");
const K = makeKeys({ db, now });
const nk = K.create(P, 'research-agent');
ok(K.resolve('Bearer ' + nk.key).pay === false && K.list(P)[0].pay === false, 'a new key cannot pay');
ok(K.setPay(G, nk.id, true) === null, 'another account cannot turn it on');
ok(K.setPay(P, nk.id, true).pay === true && K.resolve('Bearer ' + nk.key).pay === true, 'the owner turns on "Can pay"');

/* ---------- v2: key caps, address caps, audit, callbacks, fee bump, MCP ---------- */
const calls = [];
let hookDown = false;
const hook = { check: (u) => (/^https:\/\//.test(u) ? '' : 'Use an https:// URL.'), post: async (url, sec, payload) => { if (hookDown) throw new Error('HTTP 500'); calls.push({ url, sec, status: payload.data.status, event: payload.event }); } };
const keyCaps = { k1: 3, k2: null };
const R3 = makeRails({ db, secret: 'x'.repeat(40), price: async () => 3000, rpcOverrides, fetchImpl: fakeFetch, now, notify, allowDelayMin: 10,
  keyCap: (id) => keyCaps[id] ?? null, keySecret: (id) => (id === 'gone' ? null : 'sec-' + id), hook, bumpAfterMin: 10 });
const Q = 'evm:0x' + 'ef'.repeat(20); const wq = R3.createWallet(Q, '1.2.3.4 · Chrome').wallet;
const VEND2 = '0x' + '61'.repeat(20);
R3.saveSettings(Q, { daily_usd: 50, per_tx_usd: 50, wait_usd: 100, allow: [{ address: VENDOR, label: 'data-agent', daily_usd: 2 }, { address: VEND2, label: 'search-api' }] }, '1.2.3.4 · Chrome'); T += 11 * 60_000;
ok(R3.settings(Q).allow[0].daily_usd === 2 && R3.settings(Q).allow[1].daily_usd === null, 'per-address cap saved, empty means no own cap');
const pq = (x) => pay(Object.assign({ proof: { source: 'invoice', ref: 'Q-' + Math.random().toString(36).slice(2) } }, x));
// per-address cap: data-agent at most $2 a day
ok((await R3.request(Q, pq({ amount: '1.5' }))).request.status === 'queued', 'address cap: first $1.50 fits $2');
{ const r = (await R3.request(Q, pq({ amount: '1' }))).request; ok(r.status === 'stopped' && r.rail === 'LIMIT' && /"data-agent" may receive at most \$2\.00 a day/.test(r.reason), 'address cap: next $1 to data-agent stops at LIMIT'); }
ok((await R3.request(Q, pq({ amount: '1', to: VEND2 }))).request.status === 'queued', 'another allowed address is not limited by it');
// per-key cap: key k1 at most $3 a day, its own spending only
ok((await R3.request(Q, pq({ amount: '2', to: VEND2 }), 'key', { keyId: 'k1' })).request.status === 'queued', 'key cap: $2 of $3');
{ const r = (await R3.request(Q, pq({ amount: '1.5', to: VEND2 }), 'key', { keyId: 'k1' })).request; ok(r.status === 'stopped' && /This API key has its own daily cap of \$3\.00: \$2\.00 already used by it today/.test(r.reason), 'key cap: next $1.50 stops at LIMIT'); }
ok((await R3.request(Q, pq({ amount: '1.5', to: VEND2 }), 'key', { keyId: 'k2' })).request.status === 'queued', 'a key without its own cap is not limited by another key');
// audit
const au = R3.overview(Q).audit;
ok(au.some((a) => a.what === 'wallet' && /Agent wallet created/.test(a.detail)) && au.some((a) => a.what === 'settings · looser' && /allowed \+ data-agent .*max \$2\.00\/day/.test(a.detail) && a.who === '1.2.3.4 · Chrome'), 'audit: wallet created and the looser settings change, with who');
R3.saveSettings(Q, { allow: [{ address: VENDOR, label: 'data-agent', daily_usd: 10 }, { address: VEND2, label: 'search-api' }] }, 'me');
ok(/data-agent: daily \$2\.00 → \$10\.00/.test(R3.overview(Q).audit[0].detail) && R3.overview(Q).audit[0].what === 'settings · looser', 'raising an address cap is logged as looser');
R3.saveSettings(Q, { daily_usd: 40 }, 'me');
ok(R3.overview(Q).audit[0].what === 'settings' && /daily cap \$50\.00 → \$40\.00/.test(R3.overview(Q).audit[0].detail), 'tightening is logged too');
// callbacks
ok((await R3.request(Q, pq({ amount: '1', to: VEND2, callback_url: 'http://x.example/cb' }), 'key', { keyId: 'k2' })).error, 'callback must be https');
ok((await R3.request(Q, pq({ amount: '1', to: VEND2, callback_url: 'https://agent.example/cb' }))).error, 'callback only for API key requests');
chain.native['base' + wq.address] = 10n ** 17n; chain.token['base' + USDC + wq.address] = 100_000_000n;
await R3.tick(); await R3.tick(); await R3.tick();   // clear the earlier queued ones (one per tick)
const cb = (await R3.request(Q, pq({ amount: '1', to: VEND2, callback_url: 'https://agent.example/cb' }), 'key', { keyId: 'k2' })).request;
ok(cb.callback === true, 'request remembers it has a callback');
await R3.tick(); await R3.tick();
const mine = calls.filter((c) => c.url === 'https://agent.example/cb');
ok(mine.length >= 1 && mine.every((c) => c.sec === 'sec-k2' && c.event === 'rails.request') && mine.at(-1).status === 'sent', 'callback delivered for the status changes, signed with the key secret (got ' + mine.map((c) => c.status).join(',') + ')');
hookDown = true;
chain.receipts[R3.get(Q, cb.id).tx] = { blockNumber: '0x20', status: '0x1' };
T += 20_000; await R3.tick();
ok(R3.get(Q, cb.id).status === 'confirmed' && db.q('SELECT cb_tries FROM rails_requests WHERE id = ?').get(cb.id).cb_tries === 1, 'callback failure is counted and retried later');
hookDown = false; T += 31_000; await R3.tick();
ok(calls.filter((c) => c.url === 'https://agent.example/cb').at(-1).status === 'confirmed' && db.q('SELECT cb_tries FROM rails_requests WHERE id = ?').get(cb.id).cb_tries === 0, 'retry delivers "confirmed"');
// fee bump: a sent transaction without a receipt is re-signed with the same nonce and higher fees; the old hash still counts
const st0 = (await R3.request(Q, pq({ amount: '1', to: VEND2 }))).request;
await R3.tick();
const sb0 = R3.get(Q, st0.id), first = chain.sent.at(-1);
chain.latest['base' + wq.address] = first.nonce;   // not mined yet
T += 11 * 60_000; await R3.tick();
const second = chain.sent.at(-1), sb1 = R3.get(Q, st0.id);
ok(second !== first && second.nonce === first.nonce && second.maxFee >= first.maxFee * 125n / 100n && second.prio >= first.prio * 125n / 100n && sb1.fee_bumps === 1 && sb1.tx !== sb0.tx, 'stuck: same nonce, fees +25%, new hash');
T += 5 * 60_000; await R3.tick();
ok(chain.sent.at(-1) === second, 'no second bump before its own wait (×2)');
chain.receipts[sb0.tx] = { blockNumber: '0x21', status: '0x1' };   // the OLD one got mined
T += 20_000; await R3.tick();
ok(R3.get(Q, st0.id).status === 'confirmed' && R3.get(Q, st0.id).tx === sb0.tx, 'the original hash mined: confirmed with that hash');
delete chain.latest['base' + wq.address];
// MCP
const M = makeMcp({ rails: R3 });
const init = await M.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, { uid: Q, keyId: 'k2', pay: true });
ok(init.result.protocolVersion === '2025-06-18' && init.result.capabilities.tools && init.result.serverInfo.name === 'delira-rails', 'MCP initialize');
ok((await M.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, {})) === null, 'MCP notification gets no reply');
const tl = await M.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, {});
ok(tl.result.tools.map((t) => t.name).join() === 'delira_wallet,delira_pay,delira_approve,delira_status' && tl.result.tools[1].inputSchema.required.includes('idempotency_key'), 'MCP tools/list (idempotency_key required)');
const wal = await M.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delira_wallet', arguments: {} } }, { uid: Q, keyId: 'k2', pay: false });
ok(/cannot pay/.test(wal.result.content[0].text) && wal.result.structuredContent.allowed.length === 2, 'MCP wallet: read-only key is told it cannot pay');
const np = await M.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delira_pay', arguments: { chain: 'base', asset: 'USDC', to: VEND2, amount: '1', memo: 'search api credits for research', proof_source: 'invoice', proof_ref: 'S-1', idempotency_key: 'mcp-1' } } }, { uid: Q, keyId: 'k2', pay: false });
ok(np.result.isError && /cannot pay/.test(np.result.content[0].text), 'MCP pay refused without Can pay');
const mp = await M.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'delira_pay', arguments: { chain: 'base', asset: 'USDC', to: VEND2, amount: '1', memo: 'search api credits for research', proof_source: 'invoice', proof_ref: 'S-1', idempotency_key: 'mcp-1' } } }, { uid: Q, keyId: 'k2', pay: true });
ok(!mp.result.isError && mp.result.structuredContent.status === 'queued' && /Accepted: all five rails passed/.test(mp.result.content[0].text), 'MCP pay accepted');
const again2 = await M.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'delira_pay', arguments: { chain: 'base', asset: 'USDC', to: VEND2, amount: '1', memo: 'search api credits for research', proof_source: 'invoice', proof_ref: 'S-1', idempotency_key: 'mcp-1' } } }, { uid: Q, keyId: 'k2', pay: true });
ok(again2.result.structuredContent.id === mp.result.structuredContent.id && /used before/.test(again2.result.content[0].text), 'MCP retry with the same key returns the same request');
const ms = await M.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'delira_pay', arguments: { chain: 'base', asset: 'USDC', to: LIKE, amount: '1', memo: 'pay the data agent now', proof_source: 'invoice', proof_ref: 'S-2', idempotency_key: 'mcp-2' } } }, { uid: Q, keyId: 'k2', pay: true });
ok(/STOPPED by ROUTE/.test(ms.result.content[0].text) && /do not retry/.test(ms.result.content[0].text), 'MCP stop explained for the model');
const unl = await M.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'delira_approve', arguments: { chain: 'base', asset: 'USDC', spender: VEND2, amount: 'max', memo: 'let search api bill us', idempotency_key: 'mcp-3' } } }, { uid: Q, keyId: 'k2', pay: true });
ok(/STOPPED by PLAIN/.test(unl.result.content[0].text), 'MCP unlimited approval refused by PLAIN');
const mst = await M.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'delira_status', arguments: { id: mp.result.structuredContent.id } } }, { uid: Q, keyId: 'k2', pay: false });
ok(mst.result.structuredContent.id === mp.result.structuredContent.id, 'MCP status');
ok((await M.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'delira_status', arguments: { id: mp.result.structuredContent.id } } }, { uid: P, keyId: 'x', pay: true })).result.isError, 'MCP status of another account is not visible');
ok((await M.handle({ jsonrpc: '2.0', id: 11, method: 'nope' }, {})).error.code === -32601, 'MCP unknown method');
// keys: own cap
const nk2 = K.create(P, 'second-agent');
ok(K.setKey(P, nk2.id, { daily_usd: 7.5 }).daily_usd === 7.5 && K.cap(nk2.id) === 7.5 && K.setKey(P, nk2.id, { daily_usd: null }).daily_usd === null && K.cap(nk2.id) === null, 'key cap set and cleared');
ok(K.setKey(P, nk2.id, { daily_usd: -1 }).error, 'negative key cap refused');
ok(K.secret(nk2.id) === crypto.createHash('sha256').update(nk2.key).digest('hex'), 'callback secret = SHA-256 of the key');

console.log(`rails: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
