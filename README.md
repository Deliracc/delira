# DELIRA · rails for AI agents

**A wallet with rails for AI agents.** Your agent can ask to pay. Five rails decide whether it may, and only then is anything signed.

| Rail | Asks | Stops when |
|---|---|---|
| **PROOF** | Where did this amount come from? | no source, or the stated dollar value is off from the live price |
| **LIMIT** | Does it fit the budget? | over the per-request, daily, per-key or per-recipient cap, or the wallet is paused |
| **ROUTE** | Is this a place you allowed? | network or address not allowed, a look-alike address, or one added less than 10 minutes ago |
| **PLAIN** | Can it be said in one sentence? | an unreadable call, or an unlimited approval |
| **WAIT** | Why, and should a human look? | no memo; at or above the review line it waits for the owner |

This repository is the open part of [delira.cc](https://delira.cc): the rails engine, its tests, the technical book, an OpenAPI spec, SDKs for JavaScript and Python, and an MCP bridge. Read it, run it, take what you need.

> **Status: beta.** The hosted service runs on Ethereum, BNB Chain, Polygon, Arbitrum One and Base. There is no external audit yet. On delira.cc the agent wallet key is held by DELIRA, encrypted: that is custody, so keep agent budgets small.

## What is here

| Folder | What |
|---|---|
| [`docs/`](docs/README.md) | The technical book: 13 chapters, from the five rails to the security model, plus [`openapi.yaml`](docs/openapi.yaml) |
| [`engine/`](engine/) | The rails engine (`rails.mjs`), transaction signing (`evm.mjs`), the MCP server (`mcp.mjs`) and [103 tests](engine/test/rails-test.mjs) on a fake chain |
| [`sdk/`](sdk/README.md) | One-file clients: [JavaScript](sdk/js/delira.mjs), [Python](sdk/python/delira.py), and the [MCP bridge](sdk/mcp/README.md) |

Not here: the rest of the hosted service (HTTP server, sign-in, balance and top-ups, notifications, statistics) and anything about our servers.

## Use DELIRA from your agent

Any MCP client, no code:

```json
{ "mcpServers": { "delira": {
    "type": "http", "url": "https://delira.cc/api/v1/mcp",
    "headers": { "Authorization": "Bearer dlr_YOUR_KEY" } } } }
```

JavaScript:

```js
import { Delira } from './sdk/js/delira.mjs';
const d = new Delira(process.env.DELIRA_API_KEY);
const r = await d.pay({ chain: 'base', asset: 'USDC', to: '0x…', amount: '1.5',
  memo: 'weekly price report from data-agent',
  proof: { source: 'invoice', ref: 'INV-1042', usd: 1.5 },
  idempotencyKey: 'INV-1042' });
console.log(r.status === 'stopped' ? `${r.rail}: ${r.reason}` : await d.wait(r.id));
```

Get a key at [delira.cc/chat](https://delira.cc/chat): Connectors → Agents API, then turn on **Can pay** for it in Agent wallet.

## Run the engine yourself

Node 22.13 or newer. No dependencies.

```sh
npm test          # or: node engine/test/rails-test.mjs
```

```js
import { openDb } from './engine/lib/db.mjs';
import { makeRails } from './engine/lib/rails.mjs';

const rails = makeRails({
  db: openDb('./rails.db'),
  secret: process.env.RAILS_SECRET,          // 32+ random characters; encrypts agent wallet keys
  price: async (sym) => 3000,                 // your USD price source for ETH / BNB
  live: false,                                // sign but do not broadcast while you test
});
const uid = 'evm:0xyouraccount';
rails.createWallet(uid);
rails.saveSettings(uid, { allow: [{ address: '0x…', label: 'vendor' }] });
setInterval(() => rails.tick(), 5000);       // the executor: sign, send, confirm
console.log(await rails.request(uid, { action: 'pay', chain: 'base', asset: 'USDC', to: '0x…', amount: '1',
  memo: 'test payment to vendor', proof: { source: 'invoice', ref: 'T-1' }, dry_run: true }));
// → stopped by ROUTE for the first 10 minutes: a new allowed address waits (allowDelayMin), then all five pass
```

Read [chapter 4](docs/04-agent-wallet.md) before you hold real keys: the engine keeps them encrypted, but whoever runs it is their custodian.

## Links

- Product: [delira.cc](https://delira.cc) · Chat: [delira.cc/chat](https://delira.cc/chat) · User docs: [delira.cc/docs](https://delira.cc/docs)
- X: [@Deliracc](https://x.com/Deliracc) · Telegram: [t.me/deliracc](https://t.me/deliracc)
- Security: [SECURITY.md](SECURITY.md) · Changes: [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE). The vendored `@noble/secp256k1` keeps its own MIT licence ([engine/lib/secp256k1.LICENSE](engine/lib/secp256k1.LICENSE)). DELIRA's name and logo are not covered by the licence.

Let it dream. Keep the keys.
