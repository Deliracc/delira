#!/usr/bin/env node
// DELIRA rails as a local MCP server (stdio), for MCP clients that only start local commands.
// It forwards every message to https://delira.cc/api/v1/mcp with your API key. No dependencies, Node 18+.
//
//   DELIRA_API_KEY=dlr_… node delira-mcp.mjs
//   optional: DELIRA_URL=https://delira.cc (another DELIRA server)
//
// Your key never leaves this process except to DELIRA. The tools only ASK: the five rails decide on the server.
import readline from 'node:readline';

const KEY = process.env.DELIRA_API_KEY || '';
const URL_ = (process.env.DELIRA_URL || 'https://delira.cc').replace(/\/+$/, '') + '/api/v1/mcp';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const fail = (id, message) => { if (id !== undefined && id !== null) out({ jsonrpc: '2.0', id, error: { code: -32000, message } }); };

if (!/^dlr_[A-Za-z0-9_-]{40}$/.test(KEY)) {
  process.stderr.write('delira-mcp: set DELIRA_API_KEY to a DELIRA API key (dlr_…). Create one at https://delira.cc/chat → Connectors.\n');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = 0, closing = false;
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  pending++;
  try {
    const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + KEY }, body: JSON.stringify(msg), signal: AbortSignal.timeout(60_000) });
    if (r.status === 202) return;
    const j = await r.json().catch(() => null);
    if (!r.ok) return fail(msg.id, (j && j.error && j.error.message) || 'DELIRA answered HTTP ' + r.status);
    if (Array.isArray(j)) j.forEach(out); else if (j) out(j);
  } catch (e) { fail(msg.id, 'Cannot reach DELIRA: ' + e.message); }
  finally { pending--; if (closing && !pending) process.exit(0); }
});
rl.on('close', () => { closing = true; if (!pending) process.exit(0); });
