# 5 · Agent API

Base URL: `https://delira.cc/api/v1/rails`

Authentication: a DELIRA API key in the `Authorization` header.

```
Authorization: Bearer dlr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are created in the chat under **Connectors → Agents API** (up to 5 per account; shown once; stored only as a SHA-256 hash). A key can **read** the agent wallet by default. To **pay**, the owner turns on **Can pay** for that key under **Agent wallet → Keys that can pay**. A key used for the chat model API therefore cannot move money unless the owner decides so.

Rate limit: 30 requests per minute per key. Errors have the shape `{ "error": { "message": "…" } }`.

## POST /request

Ask DELIRA to make a payment from the agent wallet.

```json
{
  "action": "pay",
  "chain": "base",
  "asset": "USDC",
  "to": "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a01",
  "amount": "1.5",
  "memo": "weekly price report from data-agent",
  "proof": { "source": "invoice", "ref": "INV-1042", "usd": 1.5 },
  "idempotency_key": "job-1042"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `action` | `pay` \| `approve` \| `raw` | no (default `pay`) | `approve` sets an exact ERC-20 allowance; `raw` sends your own `to`/`value`/`data`, which DELIRA decodes |
| `chain` | `ethereum` \| `bsc` \| `polygon` \| `arbitrum` \| `base` | yes | |
| `asset` | `USDC`, `USDT`, `ETH`, `BNB` | for pay/approve | see the asset table in [chapter 3](03-rails.md#before-the-rails-normalize) |
| `to` | 0x address | yes | for `approve`: the spender |
| `amount` | decimal string | for pay/approve | `"1.5"`, up to the token's decimals |
| `value`, `data` | wei as a string, 0x hex | for raw | |
| `memo` | string | yes in practice | who, what, why; without it WAIT returns a question |
| `proof` | object | for pay | `source`: invoice, quote, feed, contract; `ref`; optional `usd` (required for `feed`) |
| `idempotency_key` | string ≤ 80 | strongly recommended | the same key always returns the same request |
| `dry_run` | boolean | no | run the rails and return the verdict without saving anything |
| `callback_url` | https URL | no | DELIRA POSTs the request here on every status change, signed (see below) |

### Response

`201` for a new request, `200` for a repeated `idempotency_key` or a dry run.

```json
{
  "id": "6f1c…",
  "status": "queued",
  "kind": "pay",
  "rail": null,
  "reason": null,
  "question": false,
  "plain": "Send 1.5 USDC on Base from the agent wallet to data-agent (0x5a5a…5a01) (about $1.50).",
  "chain": "base", "network": "Base", "asset": "USDC",
  "to": "0x5a5a…", "amount": "1.5", "usd": "1.50",
  "memo": "weekly price report from data-agent",
  "checks": [
    { "rail": "PROOF", "result": "pass", "note": "Source: invoice \"INV-1042\"; $1.50 matches $1.50." },
    { "rail": "LIMIT", "result": "pass", "note": "$1.50 of $5.00 today ($0.00 used before)." },
    { "rail": "ROUTE", "result": "pass", "note": "Recipient \"data-agent\" is on your allowed list; Base is allowed." },
    { "rail": "PLAIN", "result": "pass", "note": "Send 1.5 USDC on Base …" },
    { "rail": "WAIT",  "result": "pass", "note": "Clear memo, below your review line of $2.00." }
  ],
  "tx": null, "explorer": null,
  "created": 1763640000000, "release_at": null, "via": "key:1a2b3c4d"
}
```

| `status` | Meaning | What your agent should do |
|---|---|---|
| `queued` | passed; will be signed within seconds | poll `GET /requests/<id>` |
| `waiting` | at or above the review line; `release_at` is when it goes out unless cancelled | poll; do not resend |
| `stopped` | a rail said no; `rail` and `reason` say why; `question: true` means WAIT wants a memo | fix what `reason` says, resend with a **new** `idempotency_key` |
| `signed` | signed, being broadcast | poll |
| `sent` | in the network; `tx` and `explorer` are set | poll for `confirmed` |
| `confirmed` | included and succeeded | done |
| `failed` | not sent or reverted; `reason` has the network's words | tell a human |
| `cancelled` | the owner cancelled it | do not retry on your own |

### Errors (HTTP)

| Code | When |
|---|---|
| 400 | malformed request: unknown network, asset not on that network, bad address, bad amount |
| 401 | missing or unknown key |
| 403 | the key does not have **Can pay** |
| 404 | rails not enabled on this server; request id not found |
| 409 | the account has no agent wallet yet |
| 429 | more than 30 requests a minute on this key |

A rail stop is **not** an HTTP error: it is a `201` with `status: "stopped"`. The request is stored so the owner can see what the agent tried.

### Callbacks

```
POST <callback_url>
content-type: application/json
x-delira-event: rails.request
x-delira-signature: sha256=<HMAC-SHA-256 of the raw body>

{ "event": "rails.request", "at": "…", "data": { …the request, as in the response above… } }
```

The HMAC secret is `sha256_hex(your API key)`. Retries: 30 s, 1, 2, 4, 8 min. The SDKs have `verifyCallback` / `verify_callback`.

## GET /requests/:id

Returns the same object as above. Only requests of the key's own account are visible.

## GET /wallet

```json
{
  "wallet": { "address": "0x…", "shown": "0x… (checksummed)", "created": 1763640000000 },
  "used_today": "1.50",
  "settings": { "daily_usd": 5, "per_tx_usd": 5, "wait_usd": 2, "timelock_min": 15, "paused": false,
                "chains": ["ethereum","bsc","polygon","arbitrum","base"],
                "allow": [{ "address": "0x5a5a…", "label": "data-agent" }] },
  "balances": [{ "chain": "base", "name": "Base", "items": [{ "asset": "ETH", "amount": "0.004", "gas": true }, { "asset": "USDC", "amount": "48.5" }] }]
}
```

Only **active** allowed addresses are listed. An agent should read this before planning a payment, so it knows the caps and where it may pay.

## Examples

### curl

```bash
curl https://delira.cc/api/v1/rails/request \
  -H "Authorization: Bearer $DELIRA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"pay","chain":"base","asset":"USDC","to":"0x…","amount":"1.5",
       "memo":"weekly price report from data-agent",
       "proof":{"source":"invoice","ref":"INV-1042","usd":1.5},
       "idempotency_key":"job-1042"}'
```

### JavaScript (Node 18+)

```js
const BASE = 'https://delira.cc/api/v1/rails';
const H = { authorization: `Bearer ${process.env.DELIRA_API_KEY}`, 'content-type': 'application/json' };

export async function pay({ to, amount, memo, invoice, jobId }) {
  const r = await fetch(`${BASE}/request`, { method: 'POST', headers: H, body: JSON.stringify({
    action: 'pay', chain: 'base', asset: 'USDC', to, amount: String(amount), memo,
    proof: { source: 'invoice', ref: invoice, usd: Number(amount) },
    idempotency_key: jobId,               // retrying with the same jobId never pays twice
  }) });
  const req = await r.json();
  if (!r.ok) throw new Error(req.error.message);
  if (req.status === 'stopped') return { ok: false, rail: req.rail, reason: req.reason, question: req.question };
  // queued or waiting: follow it
  for (let i = 0; i < 120; i++) {
    const s = await (await fetch(`${BASE}/requests/${req.id}`, { headers: H })).json();
    if (['confirmed', 'failed', 'cancelled', 'stopped'].includes(s.status)) return { ok: s.status === 'confirmed', ...s };
    await new Promise((res) => setTimeout(res, s.status === 'waiting' ? 30_000 : 5_000));
  }
  return { ok: false, status: 'pending', id: req.id };
}
```

### Python

```python
import os, time, requests

BASE = "https://delira.cc/api/v1/rails"
H = {"Authorization": f"Bearer {os.environ['DELIRA_API_KEY']}"}

def pay(to, amount, memo, invoice, job_id):
    r = requests.post(f"{BASE}/request", headers=H, json={
        "action": "pay", "chain": "base", "asset": "USDC", "to": to, "amount": str(amount),
        "memo": memo, "proof": {"source": "invoice", "ref": invoice, "usd": float(amount)},
        "idempotency_key": job_id,
    }, timeout=30)
    r.raise_for_status()
    req = r.json()
    if req["status"] == "stopped":
        return {"ok": False, "rail": req["rail"], "reason": req["reason"]}
    while True:
        s = requests.get(f"{BASE}/requests/{req['id']}", headers=H, timeout=30).json()
        if s["status"] in ("confirmed", "failed", "cancelled", "stopped"):
            return {"ok": s["status"] == "confirmed", **s}
        time.sleep(30 if s["status"] == "waiting" else 5)
```

MCP clients and ready-made SDKs: see [chapter 13](13-mcp-and-sdks.md).

## Advice for agent authors

- **Always send an `idempotency_key`** derived from your job, not from time. Retries are then free.
- **Treat `stopped` as an answer, not an error.** Show `reason` to the model; it is written to be acted on.
- **Do not loop on a stop.** If PROOF or ROUTE stops, a human has to change something.
- **Read `/wallet` first** to plan within the caps and the allowed list.
- **Put the real source in `proof.ref`.** The owner reads it.
