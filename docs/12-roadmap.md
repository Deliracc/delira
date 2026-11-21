# 12 · Roadmap

No dates. Items move to "live" only when they are built and tested, and this book is updated with them.

Done since the first edition: per-key and per-recipient daily caps, the audit log, status callbacks to the agent, fee bumps for stuck transactions, the MCP server, and the JavaScript and Python SDKs.

## Next: make the beta solid

| Item | Why |
|---|---|
| First real end-to-end payment on mainnet, then each network | the only thing not yet proven with money |
| Approve or cancel from Telegram (buttons in the waiting message) | the owner should not need to open the chat to answer |

## Then: easier for agents

| Item | Why |
|---|---|
| Recurring payments (a schedule the owner approves once, each payment still checked) | subscriptions and payroll for agents |
| Invoices from vendors that PROOF can verify (signed invoice format) | PROOF moves from "a source is named" to "the source is verified" |

## Later: less custody

| Item | Why |
|---|---|
| A smart-account agent wallet where the rails are enforced on-chain, the owner's key is the admin, and DELIRA holds only a limited session key | removes most of the custody risk described in [chapter 4](04-agent-wallet.md#custody-plainly) |
| Key storage in a hardware security module or a cloud KMS | the key would not be decrypted in the server's memory |
| External security audit, then a bug bounty | outside eyes before larger budgets |
| More networks (Solana, others) | where agents actually pay |
