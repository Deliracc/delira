# 11 · Testing

## Suites

```sh
node engine/test/rails-test.mjs     # the rails engine and agent wallet (in this repository)
```

The service has three more suites (sign-in and top-ups, connectors, statistics) that test parts not published here.

No test framework: each file prints its failures and a total. They run against the real modules with an in-memory SQLite database, a fake clock and a fake chain.

| Suite | Passing | Covers |
|---|---|---|
| rails | 103 / 103 | signing vectors, key storage, every rail's stops, waiting/approve/cancel, re-check, executor, rebroadcast, withdrawals, hardening, key and recipient caps, audit log, callbacks, fee bump, MCP |
| pay | 44 / 44 | signatures (EVM, Solana), unique amounts, single credit, reorgs, native coins, limits and charging |
| connect | 36 / 36 | API keys, webhook signing and SSRF checks, Telegram, chat tools |
| traffic | 25 / 25 | device and in-app browser detection, bots, IP masking, IPv4 and IPv6 country lookup, stats, visitors, accounts, operations feed, 90-day cleanup |

## The fake chain

`rails-test.mjs` contains a small EVM node: balances, token balances, nonces, fees, `estimateGas`, receipts. Its `eth_sendRawTransaction` **decodes the RLP and recovers the sender from the signature**, so a test only passes if DELIRA produced a valid transaction signed by the right key, for the right chain, with the right nonce, recipient and calldata.

Switches let a test make the chain misbehave: refuse broadcasts, fail `estimateGas`, lag on the nonce.

## What the rails suite proves

**Signing**
- The legacy transaction matches the EIP-155 specification's test vector byte for byte.
- A type 2 transaction recovers to the wallet address; the hash is keccak of the raw bytes.
- Calldata for `transfer` and `approve` is encoded and decoded correctly; dirty padding is rejected.

**Keys**
- One wallet per account; the stored key decrypts to the wallet's address.
- A ciphertext does not decrypt under another account (AAD binding).
- The plaintext key appears nowhere in the stored row.

**Rails**
- Each stop in [chapter 3](03-rails.md) has a test with the expected message.
- A dry run answers without writing anything.
- All five pass in order for a clean request.

**Lifecycle**
- Waiting → approve → sent with the next nonce. Cancel; a cancelled request cannot be approved.
- Pausing stops queued requests before signing.
- An address removed while a request waited → stopped with "Changed while waiting".

**Executor**
- A reverted `estimateGas` is not signed. No gas → failed with a clear reason.
- A transient RPC error keeps the signed transaction, and the **same** transaction goes out next tick (no second nonce).
- Native ETH payments, exact approvals, raw ERC-20 transfers decoded as payments.

**Hardening**
- Five parallel $2 requests under a $5 cap: exactly two pass.
- With a lagging RPC, the next nonce continues from DELIRA's own record.
- "Withdraw all" ETH leaves the fee and the L2 reserve.
- Halted: requests are checked and kept, nothing is signed.
- A new API key cannot pay; another account cannot grant it; the owner can.

**Caps, audit, callbacks, fee bump, MCP**
- A recipient cap of $2 stops the next $1 to that recipient but not to another one; a key cap of $3 counts only that key's requests.
- The audit log records the wallet creation and each settings change with who made it; looser changes are marked.
- Callbacks: https only, only for API-key requests, signed with the key's secret, a failed delivery is retried and the next status arrives.
- Fee bump: same nonce, both fee fields at least +25%, a new hash; no second bump before its own wait; when the **original** hash is mined, the request is confirmed with that hash.
- MCP: initialize, notifications get no reply, four tools with `idempotency_key` required, a read-only key is told it cannot pay, a retry with the same key returns the same request, ROUTE and PLAIN stops are explained for the model, other accounts' requests are invisible.

## Checked on real networks

Transactions signed by DELIRA from an empty throwaway key were sent to public RPC nodes of all five networks:

| Network | Answer | Meaning |
|---|---|---|
| Ethereum, BNB Chain, Arbitrum One, Base | insufficient funds | the format and signature are valid; the sender was recovered correctly |
| Polygon | tip below the 25 gwei minimum | valid format; the engine now uses at least 30 gwei on Polygon |

In a local browser run (test mode), on a real wallet address: wallet creation, real balances, waiting and approval, PROOF and ROUTE stops including a look-alike, and a real `estimateGas` revert on Base for an empty wallet. The "Can pay" permission was checked in the browser: 403 before, 201 after. Against the local server, over real HTTP: the JavaScript SDK (dry run, payment, a key-cap stop), the MCP endpoint (initialize, notification 202, tools, wallet, status; GET 405, no key 401), the stdio bridge, and the Python SDK (wallet, dry run, a cap stop, a 400 error, callback signature check).

## Not verified yet

- A real payment with funds, end to end on mainnet. This is the first step after deployment, with 1–2 USDC.
- Delivery of notifications to a real Telegram bot and a real webhook from the production server.
- A fee bump on a real network (tested only on the fake chain).
- Status callbacks to a real agent server from production.
