// MCP server for the rails: any MCP-capable agent (Claude, Cursor, an Agents SDK app …) gets DELIRA as tools, no custom code.
// Transport: Streamable HTTP, stateless JSON responses at POST /api/v1/mcp with "Authorization: Bearer dlr_…".
// The tools only ASK the rails, exactly like POST /api/v1/rails/request: PROOF, LIMIT, ROUTE, PLAIN, WAIT still decide.
export const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CHAINS = ['ethereum', 'bsc', 'polygon', 'arbitrum', 'base'];

const TOOLS = [
  {
    name: 'delira_wallet',
    title: 'Agent wallet and rails',
    description: 'Read the agent wallet before paying: its address, balances on five networks, the caps (daily, per request, review line), how much is used today, the networks and the addresses you are allowed to pay. Call this first to plan a payment that fits.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'delira_pay',
    title: 'Ask DELIRA to pay',
    description: 'Ask DELIRA to send a payment from the agent wallet. Five rails check it before anything is signed: PROOF (say where the amount came from), LIMIT (caps), ROUTE (only allowed addresses and networks), PLAIN (readable in one sentence), WAIT (a memo is required; big amounts wait for the owner). A stop is a normal answer: read the reason, do not retry the same request. Use the same idempotency_key when retrying the same job, so it is never paid twice. Use dry_run to check without paying.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: CHAINS, description: 'Network' },
        asset: { type: 'string', enum: ['USDC', 'USDT', 'ETH', 'BNB'], description: 'What to send (Base has USDC and ETH; BNB only on bsc)' },
        to: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'Recipient: must be on the owner\'s allowed list' },
        amount: { type: 'string', description: 'Decimal amount, like "1.5"' },
        memo: { type: 'string', description: 'Who, what and why, in a sentence. Example: "weekly price report from data-agent"' },
        proof_source: { type: 'string', enum: ['invoice', 'quote', 'feed', 'contract'], description: 'Where the amount came from' },
        proof_ref: { type: 'string', description: 'Invoice number, quote link or feed name' },
        proof_usd: { type: 'number', description: 'The USD value the source states (required for feed); DELIRA compares it with the live price' },
        idempotency_key: { type: 'string', description: 'A stable id of this job (for example the invoice number). Same key = same payment, never twice' },
        dry_run: { type: 'boolean', description: 'Only check the rails; nothing is saved or paid' },
        callback_url: { type: 'string', description: 'Optional https URL that receives every status change, signed (x-delira-signature)' },
      },
      required: ['chain', 'asset', 'to', 'amount', 'memo', 'proof_source', 'proof_ref', 'idempotency_key'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'delira_approve',
    title: 'Ask DELIRA to approve an exact allowance',
    description: 'Ask DELIRA to let a spender use an exact amount of USDC or USDT from the agent wallet (ERC-20 approve). Unlimited approvals are always refused. The spender must be on the allowed list.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: CHAINS },
        asset: { type: 'string', enum: ['USDC', 'USDT'] },
        spender: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        amount: { type: 'string', description: 'Exact decimal amount' },
        memo: { type: 'string', description: 'Who, what and why' },
        idempotency_key: { type: 'string' },
        dry_run: { type: 'boolean' },
      },
      required: ['chain', 'asset', 'spender', 'amount', 'memo', 'idempotency_key'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'delira_status',
    title: 'Status of a payment request',
    description: 'Read a request by id: queued, waiting (for the owner, see release_at), signed, sent (with the transaction hash and explorer link), confirmed, stopped (with the rail and the reason), failed or cancelled.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The id returned by delira_pay or delira_approve' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

// what the model should read: one paragraph that says what happened and what to do next
function explain(v) {
  const head = v.dry_run ? 'Dry run: ' : '';
  const lines = [];
  if (v.status === 'stopped') {
    lines.push(`${head}${v.dry_run ? 'would be ' : ''}STOPPED by ${v.rail}. ${v.reason}`);
    lines.push(v.question ? 'Next: send it again with a clear memo (who, what, why) and a NEW idempotency_key.'
      : 'Next: do not retry the same request. Tell the user what the rail said; the owner may need to change a setting.');
  } else if (v.status === 'waiting') {
    lines.push(`${head}${v.dry_run ? 'would WAIT' : 'WAITING'} for the owner. ${v.reason || ''}`.trim());
    if (!v.dry_run) lines.push(`It goes out by itself at ${new Date(v.release_at).toISOString()} unless the owner cancels; they can also approve it now. Next: check delira_status later. Do not send it again.`);
  } else if (v.dry_run) {
    lines.push('Dry run: all five rails pass. Call again without dry_run to pay.');
  } else if (v.status === 'queued' || v.status === 'signed') {
    lines.push(`Accepted: all five rails passed, DELIRA is signing and sending it now. Next: check delira_status in a few seconds.`);
  } else if (v.status === 'sent') {
    lines.push(`SENT to the network. Transaction ${v.tx}${v.explorer ? ' · ' + v.explorer : ''}. Waiting for the confirmation.`);
  } else if (v.status === 'confirmed') {
    lines.push(`CONFIRMED on ${v.network}. Transaction ${v.tx}${v.explorer ? ' · ' + v.explorer : ''}.`);
  } else if (v.status === 'failed') {
    lines.push(`FAILED: ${v.reason}. Nothing more will happen on its own; tell the user.`);
  } else if (v.status === 'cancelled') {
    lines.push('CANCELLED by the owner. Do not retry on your own.');
  }
  if (v.plain) lines.push('In plain words: ' + v.plain);
  if (v.id) lines.push('Request id: ' + v.id);
  return lines.join('\n');
}

export function makeMcp({ rails, serverInfo = { name: 'delira-rails', title: 'DELIRA rails', version: '1.0.0' } }) {
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const text = (t, structured, isError) => ({ content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}) });

  async function call(name, a, ctx) {
    a = a && typeof a === 'object' ? a : {};
    if (name === 'delira_wallet') {
      const o = rails.overview(ctx.uid);
      if (!o.wallet) return text('There is no agent wallet yet. The owner creates it at https://delira.cc/chat (Agent wallet).', null, true);
      const s = o.settings, bal = await rails.balances(ctx.uid);
      const allow = s.allow.filter((x) => x.active).map((x) => ({ address: x.address, label: x.label, daily_usd: x.daily_usd ?? null }));
      const data = { address: o.wallet.shown, used_today_usd: o.used_today, caps: { daily_usd: s.daily_usd, per_request_usd: s.per_tx_usd, review_line_usd: s.wait_usd, timelock_min: s.timelock_min }, paused: s.paused, halted: !!o.halted, test_mode: o.live === false, networks: s.chains, allowed: allow, can_pay: !!ctx.pay, balances: bal };
      const t = [
        `Agent wallet ${o.wallet.shown} (same address on all networks).`,
        s.paused ? 'PAUSED by the owner: nothing can be paid now.' : null,
        o.halted ? 'Signing is halted by DELIRA right now.' : null,
        ctx.pay ? null : 'This API key cannot pay (the owner has not turned on "Can pay" for it). You can only read.',
        `Caps: $${o.used_today} of $${s.daily_usd} used today (UTC); at most $${s.per_tx_usd} per request; from $${s.wait_usd} a request waits ${s.timelock_min} min for the owner.`,
        `Networks: ${s.chains.join(', ') || 'none'}.`,
        allow.length ? 'You may pay: ' + allow.map((x) => `${x.label} ${x.address}${x.daily_usd != null ? ` (max $${x.daily_usd}/day)` : ''}`).join('; ') + '.' : 'No allowed addresses yet: every payment will be stopped by ROUTE until the owner adds one.',
        'Balances: ' + bal.map((n) => n.error ? `${n.name}: unavailable` : `${n.name}: ${n.items.map((i) => i.amount + ' ' + i.asset).join(', ')}`).join(' · '),
      ].filter(Boolean).join('\n');
      return text(t, data);
    }
    if (name === 'delira_pay' || name === 'delira_approve') {
      if (!ctx.pay) return text('This API key cannot pay. Ask the owner to turn on "Can pay" for this key at https://delira.cc/chat (Agent wallet → Keys that can pay).', null, true);
      const body = name === 'delira_pay'
        ? { action: 'pay', chain: a.chain, asset: a.asset, to: a.to, amount: a.amount, memo: a.memo, idempotency_key: a.idempotency_key, dry_run: !!a.dry_run, callback_url: a.callback_url,
            proof: { source: a.proof_source, ref: a.proof_ref, ...(a.proof_usd != null ? { usd: a.proof_usd } : {}) } }
        : { action: 'approve', chain: a.chain, asset: a.asset, to: a.spender, amount: a.amount, memo: a.memo, idempotency_key: a.idempotency_key, dry_run: !!a.dry_run };
      if (String(body.amount).toLowerCase() === 'unlimited' || String(body.amount).toLowerCase() === 'max') body.amount = 'unlimited';
      const r = await rails.request(ctx.uid, body, 'mcp:' + String(ctx.keyId).slice(0, 8), { keyId: ctx.keyId });
      if (r.error) return text(r.error, null, true);
      const v = Object.assign({}, r.request, r.repeated ? { repeated: true } : {});
      return text((r.repeated ? 'This idempotency_key was used before; this is that request, not a new payment.\n' : '') + explain(v), v);
    }
    if (name === 'delira_status') {
      const v = rails.get(ctx.uid, String(a.id || ''));
      if (!v) return text('No request with this id on this account.', null, true);
      return text(explain(v), v);
    }
    return null;
  }

  // one JSON-RPC message → a response object, or null for a notification
  async function handle(m, ctx) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return err(m && m.id, -32600, 'Invalid request');
    const isNote = m.id === undefined || m.id === null;
    try {
      switch (m.method) {
        case 'initialize': {
          const want = m.params && m.params.protocolVersion;
          return ok(m.id, { protocolVersion: MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo,
            instructions: 'DELIRA pays from a separate agent wallet only after five rails pass. Call delira_wallet first, then delira_pay with a memo, a proof source and an idempotency_key. A stop is an answer with a reason, not an error to retry.' });
        }
        case 'ping': return isNote ? null : ok(m.id, {});
        case 'tools/list': return ok(m.id, { tools: TOOLS });
        case 'tools/call': {
          const p = m.params || {};
          const res = await call(String(p.name || ''), p.arguments, ctx);
          return res ? ok(m.id, res) : err(m.id, -32602, 'Unknown tool: ' + p.name);
        }
        default:
          if (isNote) return null;   // notifications/initialized, notifications/cancelled …
          return err(m.id, -32601, 'Method not found: ' + m.method);
      }
    } catch (e) { return isNote ? null : err(m.id, -32603, 'Internal error'); }
  }
  return { handle, tools: TOOLS, _explain: explain };
}
