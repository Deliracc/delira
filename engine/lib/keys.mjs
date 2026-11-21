// Personal API keys for agents: "dlr_" + 40 random chars. Only a SHA-256 hash is stored; the key is shown once.
import crypto from 'node:crypto';

const MAX_KEYS = 5;
const hash = (k) => crypto.createHash('sha256').update(k).digest('hex');

export function makeKeys({ db, now = () => Date.now() }) {
  // "can pay": a key may ask the rails to move money only when the owner turned it on for that key (off by default)
  try { db.db.exec('ALTER TABLE api_keys ADD COLUMN pay INTEGER NOT NULL DEFAULT 0'); } catch { }
  // its own daily cap for payments in USD (null = only the account caps apply)
  try { db.db.exec('ALTER TABLE api_keys ADD COLUMN pay_daily REAL'); } catch { }
  const q = {
    count: db.q('SELECT COUNT(*) AS n FROM api_keys WHERE uid = ? AND revoked = 0'),
    ins: db.q('INSERT INTO api_keys(id, uid, name, hash, prefix, created) VALUES (?, ?, ?, ?, ?, ?)'),
    list: db.q('SELECT id, name, prefix, created, last_used, pay, pay_daily FROM api_keys WHERE uid = ? AND revoked = 0 ORDER BY created DESC'),
    daily: db.q('UPDATE api_keys SET pay_daily = ? WHERE id = ? AND uid = ? AND revoked = 0'),
    byId: db.q('SELECT hash, pay_daily FROM api_keys WHERE id = ? AND revoked = 0'),
    pay: db.q('UPDATE api_keys SET pay = ? WHERE id = ? AND uid = ? AND revoked = 0'),
    one: db.q('SELECT name, pay, pay_daily FROM api_keys WHERE id = ? AND uid = ? AND revoked = 0'),
    revoke: db.q('UPDATE api_keys SET revoked = 1 WHERE id = ? AND uid = ? AND revoked = 0'),
    find: db.q('SELECT id, uid, last_used, pay FROM api_keys WHERE hash = ? AND revoked = 0'),
    used: db.q('UPDATE api_keys SET last_used = ? WHERE id = ?'),
  };
  function create(uid, name) {
    const nm = String(name || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) || 'My agent';
    if (Number(q.count.get(uid).n) >= MAX_KEYS) return { error: `Up to ${MAX_KEYS} keys. Revoke one first.`, status: 409 };
    const key = 'dlr_' + crypto.randomBytes(30).toString('base64url');
    const id = crypto.randomUUID();
    q.ins.run(id, uid, nm, hash(key), key.slice(0, 10) + '…' + key.slice(-4), now());
    return { key, id, name: nm };
  }
  function list(uid) { return q.list.all(uid).map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, created: Number(r.created), last_used: r.last_used == null ? null : Number(r.last_used), pay: !!Number(r.pay), daily_usd: r.pay_daily == null ? null : Number(r.pay_daily) })); }
  function setPay(uid, id, on) { return setKey(uid, id, { pay: on }); }
  // { pay?, daily_usd? } → the old and new values, so the caller can tell whether it got looser
  function setKey(uid, id, b) {
    const k = q.one.get(String(id), uid); if (!k) return null;
    const was = { pay: !!Number(k.pay), daily_usd: k.pay_daily == null ? null : Number(k.pay_daily) }, now1 = Object.assign({}, was);
    if (b.pay != null) { now1.pay = !!b.pay; q.pay.run(now1.pay ? 1 : 0, String(id), uid); }
    if ('daily_usd' in b) {
      const v = b.daily_usd === null || b.daily_usd === '' ? null : Number(b.daily_usd);
      if (v != null && !(v >= 0 && v <= 100000)) return { error: 'The key cap is 0 to 100000 dollars a day.' };
      now1.daily_usd = v == null ? null : Math.round(v * 100) / 100; q.daily.run(now1.daily_usd, String(id), uid);
    }
    return { name: k.name, was, pay: now1.pay, daily_usd: now1.daily_usd };
  }
  // for the rails: the key's own daily cap, and the secret that signs status callbacks (SHA-256 hex of the key, which the agent can compute)
  function cap(id) { const r = q.byId.get(String(id)); return r && r.pay_daily != null ? Number(r.pay_daily) : null; }
  function secret(id) { const r = q.byId.get(String(id)); return r ? r.hash : null; }
  function revoke(uid, id) { return q.revoke.run(String(id), uid).changes === 1; }
  // "Authorization: Bearer dlr_…" → { uid, keyId } or null
  function resolve(authHeader) {
    const m = /^Bearer (dlr_[A-Za-z0-9_-]{40})$/.exec(String(authHeader || ''));
    if (!m) return null;
    const r = q.find.get(hash(m[1]));
    if (!r) return null;
    if (!r.last_used || now() - Number(r.last_used) > 60_000) q.used.run(now(), r.id);
    return { uid: r.uid, keyId: r.id, pay: !!Number(r.pay) };
  }
  return { create, list, revoke, resolve, setPay, setKey, cap, secret };
}
