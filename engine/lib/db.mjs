// SQLite store (node:sqlite, no dependencies). Money is kept as integer micro-dollars (1 USD = 1_000_000).
// The balance is never stored: it is the sum of an append-only ledger; each credit/charge has a unique (reason, ref).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, delta INTEGER NOT NULL,
      reason TEXT NOT NULL, ref TEXT NOT NULL, note TEXT, created INTEGER NOT NULL, UNIQUE(reason, ref));
    CREATE INDEX IF NOT EXISTS ledger_uid ON ledger(uid);
    CREATE TABLE IF NOT EXISTS usage (uid TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(uid, day));
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, uid TEXT NOT NULL, chain TEXT NOT NULL, asset TEXT NOT NULL,
      usd INTEGER NOT NULL, units TEXT NOT NULL, decimals INTEGER NOT NULL, rate TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','seen','paid','expired')),
      start_block INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
      paid_units TEXT, credited INTEGER, tx TEXT, paid_at INTEGER);
    CREATE INDEX IF NOT EXISTS inv_open ON invoices(chain, asset, status);
    CREATE INDEX IF NOT EXISTS inv_uid ON invoices(uid, created);
    CREATE TABLE IF NOT EXISTS payments (
      chain TEXT NOT NULL, tx TEXT NOT NULL, idx INTEGER NOT NULL, asset TEXT NOT NULL, units TEXT NOT NULL,
      block INTEGER NOT NULL, block_hash TEXT, invoice TEXT,
      status TEXT NOT NULL CHECK (status IN ('seen','confirmed','unmatched','orphaned')),
      created INTEGER NOT NULL, PRIMARY KEY(chain, tx, idx));
    CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, uid TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
      created INTEGER NOT NULL, last_used INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS keys_uid ON api_keys(uid);
    CREATE TABLE IF NOT EXISTS hooks (
      uid TEXT PRIMARY KEY, url TEXT, secret TEXT, tg_token TEXT, tg_chat TEXT, low INTEGER NOT NULL DEFAULT 1000000,
      events TEXT NOT NULL DEFAULT '["topup.credited","free.exhausted","balance.low"]', updated INTEGER NOT NULL);
  `);
  const q = (sql) => db.prepare(sql);
  const st = {
    user: q('INSERT INTO users(uid, kind, label, created) VALUES (?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET label = excluded.label'),
    balance: q('SELECT COALESCE(SUM(delta), 0) AS b FROM ledger WHERE uid = ?'),
    ledgerAdd: q('INSERT OR IGNORE INTO ledger(uid, delta, reason, ref, note, created) VALUES (?, ?, ?, ?, ?, ?)'),
    usageGet: q('SELECT n FROM usage WHERE uid = ? AND day = ?'),
    usageInc: q('INSERT INTO usage(uid, day, n) VALUES (?, ?, 1) ON CONFLICT(uid, day) DO UPDATE SET n = n + 1'),
    usageDec: q('UPDATE usage SET n = MAX(0, n - 1) WHERE uid = ? AND day = ?'),
    stateGet: q('SELECT v FROM state WHERE k = ?'),
    stateSet: q('INSERT INTO state(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
  };
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return {
    db, q, tx,
    upsertUser: (uid, kind, label, now) => st.user.run(uid, kind, label || null, now),
    balance: (uid) => Number(st.balance.get(uid).b),
    // returns true only for the first insert of (reason, ref): crediting twice is impossible
    ledger: (uid, delta, reason, ref, note, now) => st.ledgerAdd.run(uid, Math.round(delta), reason, ref, note || null, now).changes === 1,
    usage: (uid, day) => { const r = st.usageGet.get(uid, day); return r ? Number(r.n) : 0; },
    usageInc: (uid, day) => st.usageInc.run(uid, day),
    usageDec: (uid, day) => st.usageDec.run(uid, day),
    getState: (k) => { const r = st.stateGet.get(k); return r ? r.v : null; },
    setState: (k, v) => st.stateSet.run(k, String(v)),
  };
}
