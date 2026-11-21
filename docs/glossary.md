# Glossary

| Term | Meaning |
|---|---|
| **Agent** | software that acts for the owner, for example an AI model with tools |
| **Agent wallet** | a separate EVM wallet per DELIRA account, signed only by DELIRA after the rails pass |
| **Allowed list** | the addresses an agent may pay or approve; up to 50, each with a label |
| **Approve (allowance)** | an ERC-20 permission for another address to spend tokens. DELIRA allows exact amounts only |
| **Can pay** | the per-key permission that lets an API key ask for payments |
| **Custodial** | someone other than you holds the key. The agent wallet is custodial; your own wallet is not |
| **Dry run** | a request checked by the rails and answered, but not saved or signed |
| **EIP-1559** | the fee model with a base fee and a priority fee (type 2 transactions) |
| **EIP-155** | replay protection for legacy transactions: the chain id is part of the signature |
| **Halt** | the operator's switch that stops all new signing |
| **Idempotency key** | a value chosen by the agent; the same value always returns the same request |
| **Look-alike** | an address with the same first and last 4 hex characters as an allowed one, but different |
| **Memo** | the agent's sentence about who, what and why |
| **Nonce** | the sequence number of a transaction from an address; each is used once |
| **Pause** | the owner's switch that stops every request of their agent wallet |
| **Proof** | the source of an amount: invoice, quote, feed or contract, with a reference |
| **Rails** | the five checks: PROOF, LIMIT, ROUTE, PLAIN, WAIT |
| **Review line** | the dollar amount at and above which a request waits for the owner |
| **Test mode** | `RAILS_LIVE=0`: signed but not broadcast |
| **Timelock** | how long a request at or above the review line waits before it goes out by itself |
