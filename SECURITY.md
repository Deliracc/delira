# Security policy

DELIRA moves real funds from agent wallets, so security reports are welcome and taken seriously.

**Please do not open a public issue for a vulnerability.** Use GitHub's **Report a vulnerability** button on this repository (a private security advisory). Include what you found, how to reproduce it, and what an attacker could gain.

What is in scope: the rails engine (PROOF, LIMIT, ROUTE, PLAIN, WAIT), agent wallet key storage and signing, sign-in and sessions, API keys and their Can pay permission, webhooks, top-up crediting.

The design, its known gaps and what is not covered are described in [chapter 9](09-security.md). There is no external audit and no bug bounty yet.
