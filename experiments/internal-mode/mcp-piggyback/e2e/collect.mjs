import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';

// Builds evidence/live-run.json from the fixture tap logs and Codex's own
// session rollouts. Only the Khala tool calls, user prompts, and assistant
// replies are extracted from a rollout; base instructions, environment context,
// and reasoning are never copied.
//
//   collect.mjs <manifest.json> <output.json>
//
// The manifest names, per run, its fixture directory and the Codex sessions in
// launch order: { codexVersion, startedBy, launches, approvals, negativeClaims,
//   runs: { async|nonRead|restart: { fixtureDir, sessions: [{ id, rollout }] } } }
const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw new Error('usage: collect.mjs <manifest.json> <output.json>');
const MARKER = /KH201-[A-Za-z0-9-]+/;
const home = homedir();
const scrub = value => JSON.parse(JSON.stringify(value).replaceAll(home, '~'));

async function jsonl(path) {
  const text = await readFile(path, 'utf8');
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function textOf(content) {
  return (content ?? []).map(part => part.text ?? '').join('');
}

function parseArguments(value) {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value); } catch { return { unparsed: value }; }
}

// Khala tool calls the model issued, in rollout order. Codex 0.154.0 records
// an MCP call as an `mcp_tool_call_begin` event with its invocation; a
// `function_call` response item carries the same choice under a namespaced name.
function rolloutCalls(lines) {
  const begins = lines.filter(line => line.type === 'event_msg' && line.payload?.type === 'mcp_tool_call_begin'
    && line.payload.invocation?.server === 'khala');
  if (begins.length) {
    return begins.map(line => ({
      tool: line.payload.invocation.tool,
      arguments: parseArguments(line.payload.invocation.arguments),
      callId: line.payload.call_id ?? null,
      at: line.timestamp,
    }));
  }
  return lines.filter(line => line.type === 'response_item' && line.payload?.type === 'function_call'
    && /khala_(read|send)$/.test(line.payload.name ?? '')).map(line => ({
    tool: line.payload.name.match(/khala_(read|send)$/)[0],
    arguments: parseArguments(line.payload.arguments),
    callId: line.payload.call_id ?? null,
    at: line.timestamp,
  }));
}

function messages(lines, role) {
  return lines.filter(line => line.type === 'response_item' && line.payload?.type === 'message'
    && line.payload.role === role).map(line => textOf(line.payload.content));
}

function responseSummary(message) {
  const result = message.result ?? {};
  const content = result.content ?? [];
  const batches = content.map(part => part.text ?? '').filter(text => text.includes('<khala-channel-batch-v1>'));
  const batch = batches[0] ?? null;
  let primaryKind = null;
  try { primaryKind = JSON.parse(content[0]?.text ?? 'null')?.kind ?? null; } catch { primaryKind = null; }
  return {
    primaryKind,
    contentCount: content.length,
    batchCount: batches.length,
    batchToken: batch?.match(/^batchToken: (.+)$/m)?.[1] ?? null,
    releaseIds: batch ? [...batch.matchAll(/^releaseId: (.+)$/gm)].map(match => match[1]) : [],
    batchSha256: batch ? createHash('sha256').update(batch).digest('hex') : null,
    responseBytes: null,
    isError: result.isError === true,
  };
}

async function collectRun(spec) {
  const events = await jsonl(`${spec.fixtureDir}/events.jsonl`);
  const serves = events.filter(event => event.event === 'serve_start');
  const sessionOf = new Map(serves.map((serve, index) => [serve.serveId, spec.sessions[index]?.id ?? null]));
  const rollouts = new Map();
  for (const session of spec.sessions) rollouts.set(session.id, await jsonl(session.rollout));

  const calls = [];
  for (const serve of serves) {
    const session = sessionOf.get(serve.serveId);
    const agentCalls = session ? rolloutCalls(rollouts.get(session)) : [];
    const own = events.filter(event => event.serveId === serve.serveId);
    const requests = own.filter(event => event.event === 'rpc_in' && event.message?.method === 'tools/call');
    requests.forEach((request, index) => {
      const reply = own.find(event => event.event === 'rpc_out' && event.message?.id === request.message.id);
      calls.push({
        rpcId: request.message.id,
        serveId: serve.serveId,
        session,
        at: request.at,
        tool: request.message.params.name,
        arguments: request.message.params.arguments,
        response: reply ? { ...responseSummary(reply.message), responseBytes: reply.bytes } : null,
        rollout: agentCalls[index] ?? null,
      });
    });
  }

  const enqueued = events.filter(event => event.event === 'enqueued').map(event => ({
    releaseId: event.releaseId, payloadDigest: event.payloadDigest, channel: event.channel, channelLabel: event.channel,
    author: event.author, authorLabel: event.author, body: event.body, marker: event.body.match(MARKER)?.[0] ?? null,
    at: event.at,
  }));
  const statuses = events.filter(event => event.event === 'inbox_status');
  const allRollout = [...rollouts.values()].flat();
  return {
    sessions: spec.sessions.map(session => session.id),
    prompts: messages(allRollout, 'user'),
    agentMessages: messages(allRollout, 'assistant'),
    enqueued,
    serveProcesses: serves.map(serve => {
      const codex = serve.ancestors.find(process => /^\/dev\/pts\//.test(process.stdin ?? ''))
        ?? serve.ancestors.find(process => /codex/.test(process.argv.join(' '))) ?? { argv: [], stdin: null };
      return { serveId: serve.serveId, startedAt: serve.at, codexPid: codex.pid, codexArgv: codex.argv, codexStdin: codex.stdin };
    }),
    calls,
    sends: events.filter(event => event.event === 'send').map(event => ({ at: event.at, body: event.body })),
    kills: events.filter(event => event.event === 'killed'),
    inboxAfter: statuses.at(-1)?.status.cursor ?? null,
  };
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  codexVersion: manifest.codexVersion,
  startedBy: manifest.startedBy,
  trustBypassFlagsUsed: manifest.trustBypassFlagsUsed ?? [],
  launches: manifest.launches,
  approvals: manifest.approvals,
  runs: {},
  negativeClaims: manifest.negativeClaims,
};
for (const [name, spec] of Object.entries(manifest.runs)) report.runs[name] = await collectRun(spec);
await writeFile(outputPath, `${JSON.stringify(scrub(report), null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ outputPath, runs: Object.keys(report.runs) }));
