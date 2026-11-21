# 9 · Security model

This chapter lists what can go wrong and what stops it. Where nothing stops it, it says so.

## What is protected, and from whom

| Asset | Where it lives |
|---|---|
| Owner's own wallet key | with the owner only. DELIRA never sees it |
| Agent wallet keys | DELIRA's database, AES-256-GCM encrypted under `RAILS_SECRET` |
| `RAILS_SECRET`, `SESSION_SECRET`, model provider key | the server's `.env` (mode 600), readable only by the `api` container |
| API keys | only their SHA-256 hash is stored |
| Telegram bot tokens, webhook secrets | encrypted in the database |
| Balance | the `ledger` table; every change has a unique reference |

## Threats from the agent

| Threat | What stops it |
|---|---|
| Prompt injection makes the agent pay an attacker | ROUTE: only allowed addresses; new ones wait 10 min and notify the owner |
| Address poisoning (a look-alike address in history) | ROUTE names look-alikes (same first 4 and last 4 hex characters) and refuses them |
| A fake or inflated invoice | PROOF requires a source; a stated USD value must match the live price within the tolerance. *A genuine-looking invoice with the right price to an allowed vendor still passes*: that is the owner's trust in the vendor |
| Draining by many small payments | LIMIT: per-request and daily caps; parallel requests are checked one at a time per account |
| Unlimited approval, `setApprovalForAll`, unknown contract calls | PLAIN refuses anything it cannot say in one sentence, and every unlimited approval |
| Paying twice on retry | `idempotency_key` is unique per account; a signed transaction is stored and re-sent as the same bytes |
| Paying with no reason | WAIT requires a memo; big amounts wait for a human |
| A leaked chat API key used to pay | Keys cannot pay unless the owner turns on Can pay for that key; turning it on notifies the owner |

## Threats from a stolen owner session

A session token stolen from a browser is the most likely serious attack.

| What the attacker tries | What happens |
|---|---|
| Add their address and pay to it | the address becomes usable only after 10 minutes; the owner gets a notification that cannot be turned off |
| Raise the caps, resume a paused wallet | allowed, but the owner gets a notification that cannot be turned off |
| Give an API key Can pay | allowed, with a notification that cannot be turned off |
| Hide what they did | every change is in the audit log with the IP and browser; the owner sees it under Changes |
| Withdraw to their own address | refused: withdrawals go only to the sign-in wallet or an *active* allowed address |
| Call owner routes from another website | refused: changes require the request to come from DELIRA's own origin |

What is **not** covered: an attacker with a stolen session who waits out the 10 minutes while the owner ignores the notifications. The owner's answer is **Pause**, which stops everything at once, including queued requests at the final check.

## Threats to the server

| Threat | Mitigation | Remaining risk |
|---|---|---|
| Database copied | keys are encrypted; the encryption key is not in the database | if `.env` is copied too, the agent wallets are exposed |
| Server fully compromised | none in software. The agent wallet is custodial | everything in the agent wallets. **This is why budgets must be small** |
| `RAILS_SECRET` lost | none | the agent wallets cannot sign again. Keep an offline copy |
| A bug in the rails engine | small code base, tests with a fake chain, re-check before signing | no external audit yet |
| Malicious npm package | the server has no npm dependencies | the vendored secp256k1 library is trusted |
| Lying RPC node | estimateGas and receipts come from the RPC; operators can use their own nodes | a malicious RPC could hide a failure or a receipt. It cannot make DELIRA sign something the rails refused, because the rails run on DELIRA's own decoding, not the RPC's |
| Wrong price from one source | median of three sources | if two of three agree on a wrong price, PROOF and LIMIT use it |
| SSRF through webhooks | https only, public IPs only, no redirects, no IP literals | |
| Abuse and floods | Cloudflare in front (DDoS protection), then per-IP, per-account and per-key rate limits; memory and CPU caps on containers | a very large attack can still slow the service |
| Spoofed visitor IP (a fake CF-Connecting-IP sent straight to the server) | the header is trusted only from published Cloudflare ranges | |
| Clickjacking (a hidden DELIRA page under another site, tricking a click on Approve) | `X-Frame-Options: DENY` and `frame-ancestors 'none'` on every page | |
| Downgrade to HTTP | HSTS for a year, including subdomains | |
| Operator views | a long random operator key compared in constant time; repeated wrong keys from one IP are locked out; a strict CSP | a single shared secret: rotated if it leaks |

## Cryptography used

| Purpose | Algorithm |
|---|---|
| Agent wallet key | secp256k1 (`@noble/secp256k1`, vendored, low-s) |
| Transaction signing | EIP-1559 type 2; legacy with EIP-155 on BNB Chain |
| Key encryption at rest | AES-256-GCM, 96-bit random IV, account id as additional data |
| Key derivation for encryption | SHA-256 of a fixed label + `RAILS_SECRET` (the secret is at least 32 random characters) |
| Sessions | HMAC-SHA-256 |
| API keys | 240 random bits, stored as SHA-256 |
| Webhooks | HMAC-SHA-256 signature header |

## Honest gaps

- No external audit. No bug bounty yet.
- The agent wallet is custodial. Non-custodial enforcement on-chain is a future design.
- No hardware security module: the key is decrypted in the server process memory for the moment of signing.
- The look-alike check compares the first 4 and last 4 hex characters. An address that differs there is not named as a look-alike, but it is still refused, because it is not on the allowed list.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's **Report a vulnerability** (private security advisory) on this repository.
