# DELIRA rails over MCP

Give any MCP-capable agent a budget it cannot misuse. The agent gets four tools. It can only **ask**; the five rails (PROOF, LIMIT, ROUTE, PLAIN, WAIT) decide on the DELIRA server, and DELIRA signs only what passes.

| Tool | What it does |
|---|---|
| `delira_wallet` | address, balances, caps, used today, allowed networks and addresses |
| `delira_pay` | ask for a payment (USDC, USDT, ETH, BNB) with a memo, a proof source and an idempotency key; `dry_run` to only check |
| `delira_approve` | ask for an exact ERC-20 allowance (unlimited is always refused) |
| `delira_status` | follow a request: queued, waiting, sent, confirmed, stopped with the reason |

## Before you start

1. Sign in at [delira.cc/chat](https://delira.cc/chat), open **Agent wallet**, create the wallet, add the addresses your agent may pay, and fund it with a small amount.
2. Create an API key in **Connectors → Agents API**.
3. In **Agent wallet → Keys that can pay**, turn on **Can pay** for that key, and set its own daily cap if you like.

## Option A: remote server (no install)

The server is `https://delira.cc/api/v1/mcp` (Streamable HTTP, JSON responses). Clients that support remote servers with a header:

```json
{
  "mcpServers": {
    "delira": {
      "type": "http",
      "url": "https://delira.cc/api/v1/mcp",
      "headers": { "Authorization": "Bearer dlr_YOUR_KEY" }
    }
  }
}
```

Claude Code:

```sh
claude mcp add --transport http delira https://delira.cc/api/v1/mcp --header "Authorization: Bearer $DELIRA_API_KEY"
```

## Option B: local bridge (stdio)

For clients that only start local commands (Claude Desktop, Cursor and others). One file, no dependencies, Node 18+.

```json
{
  "mcpServers": {
    "delira": {
      "command": "node",
      "args": ["/path/to/delira-mcp.mjs"],
      "env": { "DELIRA_API_KEY": "dlr_YOUR_KEY" }
    }
  }
}
```

The bridge forwards each message to the remote server. Your key goes only to DELIRA.

## What the agent sees

A stop is a normal tool result, written for the model to act on:

```
STOPPED by ROUTE. 0x5a5a…5a01 looks like your allowed "data-agent" (0x5a5a…) but it is a different address. Refused.
Next: do not retry the same request. Tell the user what the rail said; the owner may need to change a setting.
```

Every result also carries the full request as `structuredContent` (id, status, rail, reason, checks, tx, explorer).

## Safety notes

- A key without **Can pay** can only use `delira_wallet` and `delira_status`.
- `idempotency_key` is required by the tool schema: an agent that retries the same job gets the same request back, never a second payment.
- Everything else (caps, allowed list, review line, timelock, pause) is set by the owner in DELIRA, not by the agent.
