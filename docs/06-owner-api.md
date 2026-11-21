# 6 · Owner API

These routes are what the DELIRA chat and settings pages call for the signed-in owner. They take the session token in the `x-delira-session` header. A request that changes something (any method other than GET) must come from DELIRA's own site: the `Origin` header has to be on the allowed list, so another website cannot drive an owner's session.

The agent never calls these. Its routes are in [chapter 5](05-agent-api.md).

## Rails

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/rails` | | wallet, settings, defaults, networks, `used_today`, `waiting`, `allow_delay_min`, `live`, `halted`, the last 50 requests, the last 40 audit entries |
| `GET /api/rails/balances` | | native and token balances on all five networks (cached 15 s) |
| `POST /api/rails/wallet` | | creates the agent wallet (once; repeated calls return the same one). 5 per minute |
| `PUT /api/rails/settings` | any of `daily_usd`, `per_tx_usd`, `wait_usd`, `timelock_min`, `tolerance_pct`, `paused`, `chains[]`, `allow[{address,label,daily_usd?}]` | the saved settings |
| `POST /api/rails/request` | same as the agent's request; `dry_run` supported | a request. Used by "Try a request" in the panel |
| `POST /api/rails/requests/:id/approve` | | re-checks a waiting request and queues it |
| `POST /api/rails/requests/:id/cancel` | | cancels a waiting or queued request |
| `POST /api/rails/withdraw` | `chain`, `asset`, `amount` (or `"all"`), optional `to` | a queued withdrawal |

`allow` is sent as the whole list. Addresses already on it keep their original activation time; new ones become active after the delay. The agent wallet's own address is dropped from the list.

## API keys

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/keys` | | `{ keys: [{ id, name, prefix, created, last_used, pay }] }` |
| `POST /api/keys` | `{ name }` | `{ key, id, name }`: the only time the full key is shown |
| `PUT /api/keys/:id` | `{ pay?: true \| false, daily_usd?: number \| null }` | turns **Can pay** on or off and sets the key's own daily cap. Turning pay on or raising/removing the cap always notifies the owner and is logged |
| `DELETE /api/keys/:id` | | revokes the key |

## Notifications

| Method and path | Body |
|---|---|
| `GET /api/hooks` | current webhook URL, whether Telegram is on, chosen events |
| `PUT /api/hooks` | `url`, `tg_token`, `tg_chat`, `events[]`, `low_usd` (the balance.low line). An empty `url` and `tg_token` turn notifications off |
| `POST /api/hooks/test` | sends a test message |

Rail events: `rails.waiting` (always sent), `rails.changed` (always sent when settings get looser), `rails.key` (always sent when a key gets Can pay), `rails.stopped`, `rails.sent`, `rails.failed` (by choice).

## Account and balance

| Method and path | Returns |
|---|---|
| `GET /api/me` | account, balance, free messages left today, rails summary (`on`, `wallet`, `waiting`) |
| `GET /api/billing` | balance, top-ups, 14 days of usage, manual adjustments |
| `POST /api/pay/invoice` | a top-up invoice (see [chapter 7](07-accounts-and-balance.md)) |
| `GET /api/pay/invoice/:id` | invoice status |
| `GET /api/pay/invoices` | the owner's invoices |
