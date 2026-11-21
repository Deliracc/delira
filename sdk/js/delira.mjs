// DELIRA rails SDK for JavaScript (Node 18+, Deno, Bun). One file, no dependencies.
// Your agent asks; the five rails (PROOF, LIMIT, ROUTE, PLAIN, WAIT) decide on the DELIRA server.
//
//   import { Delira } from './delira.mjs';
//   const d = new Delira(process.env.DELIRA_API_KEY);
//   const r = await d.pay({ chain: 'base', asset: 'USDC', to: '0x…', amount: '1.5',
//     memo: 'weekly price report from data-agent', proof: { source: 'invoice', ref: 'INV-1042', usd: 1.5 },
//     idempotencyKey: 'INV-1042' });
//   if (r.status === 'stopped') console.log(r.rail, r.reason); else console.log(await d.wait(r.id));

const FINAL = new Set(['confirmed', 'failed', 'cancelled', 'stopped']);

export class DeliraError extends Error {
  constructor(message, status) { super(message); this.name = 'DeliraError'; this.status = status; }
}

export class Delira {
  /** @param {string} apiKey a DELIRA API key (dlr_…); to pay, the owner turns on "Can pay" for it */
  constructor(apiKey, { baseUrl = 'https://delira.cc', fetch: f = globalThis.fetch, timeoutMs = 30_000 } = {}) {
    if (!/^dlr_[A-Za-z0-9_-]{40}$/.test(String(apiKey || ''))) throw new DeliraError('A DELIRA API key looks like dlr_ + 40 characters.', 0);
    this.key = apiKey; this.base = baseUrl.replace(/\/+$/, '') + '/api/v1/rails'; this.fetch = (...a) => f(...a); this.timeoutMs = timeoutMs;
  }

  async #call(method, path, body) {
    const r = await this.fetch(this.base + path, {
      method, signal: AbortSignal.timeout(this.timeoutMs),
      headers: { authorization: 'Bearer ' + this.key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new DeliraError((j.error && j.error.message) || 'HTTP ' + r.status, r.status);
    return j;
  }

  /** Address, caps, used today, allowed networks and addresses, balances. Read it before planning a payment. */
  wallet() { return this.#call('GET', '/wallet'); }

  /**
   * Ask for a payment. Returns the request: status queued | waiting | stopped (a rail said no: see rail, reason).
   * A stop is an answer, not an exception. Errors (bad input, key cannot pay, …) throw DeliraError.
   * @param {{chain:string, asset:string, to:string, amount:string|number, memo:string,
   *   proof:{source:'invoice'|'quote'|'feed'|'contract', ref:string, usd?:number},
   *   idempotencyKey:string, dryRun?:boolean, callbackUrl?:string}} p
   */
  pay(p) {
    need(p, ['chain', 'asset', 'to', 'amount', 'memo', 'proof', 'idempotencyKey']);
    return this.#call('POST', '/request', { action: 'pay', chain: p.chain, asset: p.asset, to: p.to, amount: String(p.amount), memo: p.memo, proof: p.proof,
      idempotency_key: String(p.idempotencyKey), dry_run: p.dryRun || undefined, callback_url: p.callbackUrl || undefined });
  }

  /** Ask for an exact ERC-20 allowance (unlimited is always refused). */
  approve(p) {
    need(p, ['chain', 'asset', 'spender', 'amount', 'memo', 'idempotencyKey']);
    return this.#call('POST', '/request', { action: 'approve', chain: p.chain, asset: p.asset, to: p.spender, amount: String(p.amount), memo: p.memo,
      idempotency_key: String(p.idempotencyKey), dry_run: p.dryRun || undefined, callback_url: p.callbackUrl || undefined });
  }

  /** Only check the rails: nothing is saved or paid. */
  check(p) { return this.pay(Object.assign({}, p, { dryRun: true })); }

  /** Read a request by id. */
  status(id) { return this.#call('GET', '/requests/' + encodeURIComponent(id)); }

  /**
   * Follow a request until it is final (confirmed, failed, cancelled, stopped) or the time runs out.
   * Waiting requests are polled slowly: they wait for the owner.
   */
  async wait(id, { timeoutMs = 30 * 60_000, everyMs = 5_000, onChange } = {}) {
    const end = Date.now() + timeoutMs; let last = null;
    for (;;) {
      const r = await this.status(id);
      if (r.status !== last) { last = r.status; if (onChange) onChange(r); }
      if (FINAL.has(r.status) || Date.now() > end) return r;
      await new Promise((res) => setTimeout(res, r.status === 'waiting' ? Math.max(everyMs, 30_000) : everyMs));
    }
  }

  /**
   * Check a status callback (callbackUrl). DELIRA signs the raw body with HMAC-SHA-256;
   * the secret is the SHA-256 (hex) of your API key. Pass the raw body exactly as received.
   */
  async verifyCallback(rawBody, signatureHeader) { return verifyCallback(this.key, rawBody, signatureHeader); }
}

export async function verifyCallback(apiKey, rawBody, signatureHeader) {
  const enc = new TextEncoder(), sub = globalThis.crypto.subtle;
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const secret = hex(await sub.digest('SHA-256', enc.encode(apiKey)));
  const k = await sub.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = 'sha256=' + hex(await sub.sign('HMAC', k, typeof rawBody === 'string' ? enc.encode(rawBody) : rawBody));
  const got = String(signatureHeader || '');
  if (got.length !== want.length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return d === 0;
}

function need(p, keys) {
  for (const k of keys) if (p == null || p[k] == null || p[k] === '') throw new DeliraError(`"${k}" is required.`, 0);
}
