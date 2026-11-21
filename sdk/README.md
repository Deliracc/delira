# DELIRA SDKs

Small clients for the DELIRA rails. Each is one file with no dependencies: copy it into your project.

| Folder | For |
|---|---|
| [`mcp/`](mcp/README.md) | any MCP client (Claude, Cursor, agent frameworks): remote server config and a one-file stdio bridge |
| [`js/delira.mjs`](js/delira.mjs) | Node 18+, Deno, Bun |
| [`python/delira.py`](python/delira.py) | Python 3.8+, standard library only |

All of them only **ask**. The five rails decide on the server, and DELIRA signs only what passes. See the [technical book](../docs/README.md) for how the rails work.

## The same flow in every SDK

```js
const d = new Delira(process.env.DELIRA_API_KEY);
const w = await d.wallet();                       // caps, allowed addresses, balances
const r = await d.pay({ chain: 'base', asset: 'USDC', to: w.settings.allow[0].address, amount: '1.5',
  memo: 'weekly price report from data-agent',
  proof: { source: 'invoice', ref: 'INV-1042', usd: 1.5 },
  idempotencyKey: 'INV-1042' });                  // retrying the same job never pays twice
if (r.status === 'stopped') console.log(`${r.rail}: ${r.reason}`);   // an answer, not an exception
else console.log(await d.wait(r.id));            // queued/waiting → sent → confirmed
```

```python
d = Delira(os.environ["DELIRA_API_KEY"])
r = d.pay(chain="base", asset="USDC", to=addr, amount="1.5", memo="weekly price report from data-agent",
          proof={"source": "invoice", "ref": "INV-1042", "usd": 1.5}, idempotency_key="INV-1042")
print(r["rail"], r["reason"]) if r["status"] == "stopped" else print(d.wait(r["id"]))
```

## Status callbacks instead of polling

Pass `callbackUrl` / `callback_url` (https, public host). DELIRA POSTs the request to it on every status change:

```
x-delira-event: rails.request
x-delira-signature: sha256=<HMAC-SHA-256 of the raw body>
```

The HMAC secret is the **SHA-256 (hex) of your API key**, so there is nothing extra to store. Check it with `verifyCallback(rawBody, header)` / `verify_callback(raw_body, header)` before trusting the body. Failed deliveries are retried 5 times with growing pauses (30 s, 1, 2, 4, 8 min).

## Errors

| Thrown | When |
|---|---|
| `DeliraError` 400 | bad input: unknown network, asset not on that network, bad address or amount |
| `DeliraError` 401 | unknown or revoked key |
| `DeliraError` 403 | the key does not have **Can pay** |
| `DeliraError` 409 | no agent wallet on this account yet |
| `DeliraError` 429 | too many requests (30 a minute per key) |

A rail stop is **not** an error: it is a normal result with `status: "stopped"`, the `rail` and a `reason` written to be acted on.
