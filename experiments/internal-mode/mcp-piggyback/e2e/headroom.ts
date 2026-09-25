import { createHash, randomUUID } from 'node:crypto';
import type { InboxBatch } from '../../../../packages/agent-cli/src/cli/inbox.ts';
import {
  MCP_SOFT_RESPONSE_BYTES, mcpPayloadBudget, renderInboxBatch, type McpToolResult,
} from '../../../../packages/agent-cli/src/mcp/result-postprocessor.ts';

// Measures how much of the 128 KiB soft response limit the product byte budget
// actually uses. The budget divides the space left after worst-case framing by
// the 6x worst-case JSON escape expansion; this compares the admitted payload
// with the complete serialized JSON-RPC line for plain-ASCII, typical-chat,
// and escape-heavy bodies.
//
//   tsx headroom.ts   (prints one JSON report)
const encoder = new TextEncoder();
// Canonical release JSON already escapes control characters, so re-escaping it
// can at most double a byte (`"` and `\`). Only a non-canonical payload with raw
// control bytes reaches the 6x `\u00XX` expansion the budget assumes; the inbox
// does not currently reject one, so it is measured as `raw-control`.
const bodies = {
  'plain-ascii': 'a',
  'typical-chat': 'Sounds good - "ship it" when CI is green.\n',
  'control-escaped': '\u0001',
  'quote-heavy': '"',
} as const;

function sendPrimary(): McpToolResult {
  const safe = { kind: 'accepted', clientTxnId: randomUUID(), eventId: 'event-sent-1790324330813' };
  return { content: [{ type: 'text', text: JSON.stringify(safe) }], structuredContent: safe };
}

function release(bindingId: string, body: string): Uint8Array {
  const tuple = ['khala.release.v1', `release-${randomUUID()}`, bindingId, 1, 1,
    [['channel-headroom', `event-${randomUUID()}`, 'participant-peer', 'device-peer', `sha256:${'0'.repeat(64)}`, body]]];
  return encoder.encode(JSON.stringify(tuple));
}

// Builds `count` equal releases whose payloads total at most `budget` bytes.
function batch(unit: string, budget: number, count: number): InboxBatch {
  const overhead = release('binding-headroom', '').byteLength;
  const perRelease = Math.floor(budget / count);
  const unitBytes = Buffer.byteLength(JSON.stringify(unit).slice(1, -1));
  const repeats = Math.max(0, Math.floor((perRelease - overhead) / unitBytes));
  const items = Array.from({ length: count }, (_, index) => {
    const payload = release('binding-headroom', unit.repeat(repeats));
    const releaseId = `release-${index}-${randomUUID()}`;
    return {
      record: {
        v: 1, releaseId, bindingId: 'binding-headroom', generation: 1, events: [],
        payloadDigest: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
        payloadBase64: Buffer.from(payload).toString('base64'), receivedAt: '2026-09-25T00:00:00Z',
      },
      payload,
      nextOffset: index + 1,
    };
  });
  return { token: randomUUID(), items } as unknown as InboxBatch;
}

function serialized(id: number, primary: McpToolResult, text: string): number {
  const result = { ...primary, content: [...primary.content, { type: 'text', text }] };
  return Buffer.byteLength(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

const primary = sendPrimary();
const budget = mcpPayloadBudget(12, primary);
const rows = Object.entries(bodies).flatMap(([name, unit]) => [1, 8].map(count => {
  const selected = batch(unit, budget, count);
  const payloadBytes = selected.items.reduce((sum, item) => sum + item.payload.byteLength, 0);
  const responseBytes = serialized(12, primary, renderInboxBatch(selected));
  return {
    body: name,
    releases: count,
    payloadBytes,
    responseBytes,
    softLimitUsed: Number((responseBytes / MCP_SOFT_RESPONSE_BYTES).toFixed(3)),
    expansion: Number((responseBytes / payloadBytes).toFixed(2)),
  };
}));
const raw = batch('a', budget, 1);
const rawPayload = new Uint8Array(budget).fill(0x01);
const rawBatch = { ...raw, items: [{ ...raw.items[0]!, payload: rawPayload }] } as InboxBatch;
const rawBytes = serialized(12, primary, renderInboxBatch(rawBatch));
rows.push({
  body: 'raw-control (non-canonical)', releases: 1, payloadBytes: budget, responseBytes: rawBytes,
  softLimitUsed: Number((rawBytes / MCP_SOFT_RESPONSE_BYTES).toFixed(3)),
  expansion: Number((rawBytes / budget).toFixed(2)),
});
console.log(JSON.stringify({ softResponseBytes: MCP_SOFT_RESPONSE_BYTES, sendResultPayloadBudget: budget, rows }, null, 2));
