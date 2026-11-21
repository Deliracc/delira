# 10 · Operations

How the hosted DELIRA service is run, in general terms. Exact hosts, paths and schedules of our own server are not published.

## Configuration

All settings come from environment variables kept only on the server. They are never committed.

### Rails

| Variable | Default | Meaning |
|---|---|---|
| `RAILS_SECRET` | | ≥ 32 random characters, separate from the session secret. Turns the rails on and encrypts the agent wallet keys. **Never change it after launch. Keep a copy off the server.** |
| `RAILS_LIVE` | on | `0` = sign but do not broadcast (test mode) |
| `RAILS_HALT` | off | `1` = emergency halt: nothing new is signed |
| `RAILS_ALLOW_DELAY_MIN` | 10 | minutes before a new allowed address is usable |
| `RAILS_BUMP_MIN` | 10 | minutes before a stuck transaction gets a higher fee (then ×2, ×3; at most 3 bumps) |
| `RPC_ETHEREUM`, `RPC_BSC`, `RPC_POLYGON`, `RPC_ARBITRUM`, `RPC_BASE` | public nodes | own RPC nodes instead of public ones |

The rest of the service (models, sign-in, balance, limits) has its own variables; they are not part of the engine in this repository.

## Turning the rails on for the first time

1. Generate the secret **on the server** and store it in the environment:
   ```sh
   echo "RAILS_SECRET=$(openssl rand -hex 32)"   # keep this value only on the server and in an offline copy
   ```
2. Start in test mode (`RAILS_LIVE=0`): requests are checked and signed, nothing is broadcast.
3. Create a wallet, run requests, watch them get signed but not sent.
4. Switch test mode off and send one small real payment end to end before anything larger.

## Edge and network

The service runs behind Cloudflare: DDoS protection, caching of code and media, TLS end to end.

| Setting | Value | Why |
|---|---|---|
| SSL/TLS | Full (strict) | encrypted to the server too, with a valid certificate |
| Bot protection that challenges requests | off | it would stop agents, SDKs and MCP clients calling the API |
| Script and email rewriting | off | they change pages and scripts |
| Caching | pages and `/api` not cached; code 60 s, media 1 h | a deploy shows within a minute |

The server trusts `CF-Connecting-IP` and `CF-IPCountry` only when the request reached it from a published Cloudflare range, so rate limits and statistics see the real visitor and the headers cannot be spoofed by calling the server directly.

## Backups

The database holds encrypted agent wallet keys, so it is backed up every night with a consistent SQLite snapshot (`VACUUM INTO`) and an integrity check, kept for two weeks and copied off the server.

Backups and the `RAILS_SECRET` copy are kept **in different places**. Together they are the agent wallets; each alone is useless.

## Emergency

| Situation | Action |
|---|---|
| Something looks wrong with signing | set `RAILS_HALT=1` and restart. Requests are kept; nothing new is signed; sent ones are still followed to a receipt |
| One account is attacked | the owner presses **Pause** in the agent wallet panel |
| A bad deploy | roll back to the previous version of the code |
| Data loss | restore the last snapshot; the keys inside it decrypt only with the same `RAILS_SECRET` |

## Monitoring

A watchdog checks every minute and alerts the team once when something breaks and once when it is fixed:

| Check | Alert when |
|---|---|
| health endpoint and the home page | no answer twice in a row |
| the API process | not running |
| disk | 90% full |
| backups | none in the last 2 days |
| rails | a burst of failed payments |

- `GET /api/healthz` returns `ok`.
- The log has one line per notable event (`rails fail`, `rails exec`), never a secret.
- Requests stuck in `signed` for more than 10 minutes become `failed` with the network's message.

## Statistics

The site counts visits first-party: no cookies and no third-party analytics. Without cookie consent a page is counted anonymously (page, source, country, continent, device; no id, no stored IP). With consent, a random visitor id links page views. Global Privacy Control and Do Not Track are honoured. Countries come from a local copy of IP geolocation by DB-IP (CC BY 4.0). Visits are deleted after 90 days. The details are in the privacy policy at [delira.cc/docs#privacy](https://delira.cc/docs#privacy).
