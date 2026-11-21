# Changelog

Dates are the days the change was released. Newest first.

## 2026-11-21

**Rails v2**
- MCP server at `/api/v1/mcp` with four tools (`delira_wallet`, `delira_pay`, `delira_approve`, `delira_status`), plus a one-file stdio bridge.
- JavaScript and Python SDKs (one file each, no dependencies).
- Daily caps per API key and per recipient, on top of the account caps.
- Audit log of every change to the rails, keys, approvals and withdrawals, with IP and browser.
- Status callbacks to the agent (`callback_url`), signed with HMAC-SHA-256.
- Fee bump for stuck transactions: same nonce, fees +25%, at most 3 times.
- Real sending switched on in production after a test-mode run.

**Operations**
- Nightly database backups with an integrity check, kept 14 days.
- A watchdog every minute (site, API, container, disk, backups, rails failures) with Telegram alerts.
- Security headers on every page: no framing, HSTS, nosniff, Referrer-Policy, Permissions-Policy.
- Admin dashboard: visitors, sources, utm campaigns, countries, devices, accounts and every operation.
- First-party page-view statistics, no cookies; Global Privacy Control and Do Not Track are honoured. Privacy policy and terms updated.

## 2026-11-20

- Rails engine (beta): a separate agent wallet per account; PROOF, LIMIT, ROUTE, PLAIN, WAIT before every signature, on Ethereum, BNB Chain, Polygon, Arbitrum One and Base.
- Hardening: per-account lock against parallel requests, nonce record against lagging RPC nodes, **Can pay** per API key (off by default), operator halt (`RAILS_HALT`), correct fees for "withdraw all".
- The technical book.

## 2026-11-19

- Production server and auto-deploy of the site; clean URLs.
- Sign-in by wallet signature (EVM, Solana) and Google, checked by the server.
- Balance: free daily messages, usage billing, top-ups in USDT, USDC, ETH and BNB on five networks with a deposit checker.
- Connectors: API keys for agents, an OpenAI-compatible model API, live chat tools, Telegram and webhook notifications.
- Model market with prices; bring your own key; compare mode.
- Docs, product page, privacy policy and terms.

## 2026-11-18

- First version: landing, chat, sign-in, profile.
