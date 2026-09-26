// Model-facing surface inventory for the security boundary suite (KHA-138).
//
// `discoverSurfaces` enumerates what the built code actually registers: MCP tools,
// Claude and OpenCode tool sets, agent CLI commands and `claude` ops, hook events,
// loopback and hosted HTTP routes, and harness adapters. `SURFACE_INVENTORY` is the
// checked list. Every discovered surface must appear in it with a coverage
// decision, and every listed surface must still be discovered. A surface marked
// `probe` is driven against an unreleased canary by the named probe in
// `airlock.test.ts`, which fails when a listed surface has no implementation. A
// surface marked `not-observed` is an explicit gap carried into the evidence file,
// never a pass.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverRoutes } from '../../../apps/control/src/runtime/discover';
import { DISCOVERY_ROUTES } from '../../../apps/internal/src/server/discovery';
import { CLI_COMMANDS } from '../../../packages/agent-cli/src/cli/registry';
import { CODEX_APP_HOOK_EVENTS } from '../../../packages/agent-cli/src/codex-app/hook';
import { CODEX_HOOK_EVENTS } from '../../../packages/agent-cli/src/codex/hook';
import { CLAUDE_COMMAND_OPS } from '../../../packages/agent-cli/src/composition/claude-command';
import { createClaudeToolRegistry } from '../../../packages/agent-cli/src/composition/claude-mcp';
import { MCP_TOOLS } from '../../../packages/agent-cli/src/mcp/registry';
import { createKhalaOpenCodeServer, unavailableOpenCodeDependencies } from '../../../packages/agent-cli/src/opencode/plugin';
import { FROZEN_HOOK_EVENTS, FROZEN_MCP_TOOLS } from '../../../packages/claude-plugin/src/contract';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Probes implemented in `airlock.test.ts`. */
export const PROBES = ['internal-http', 'agent-cli', 'mcp-serve', 'dispatcher-gate'] as const;
export type ProbeId = (typeof PROBES)[number];

export type Coverage =
  /** Driven against an unreleased canary by this probe. */
  | Readonly<{ kind: 'probe'; probe: ProbeId }>
  /** Reachable only by the authenticated human, the trusted endpoint (KTD3). Still probed with agent credentials where the route is shared. */
  | Readonly<{ kind: 'human-only'; reason: string }>
  /** Not exercised by this suite. Recorded as not-observed evidence, never as a pass. */
  | Readonly<{ kind: 'not-observed'; reason: string }>;

const probe = (id: ProbeId): Coverage => ({ kind: 'probe', probe: id });
const notObserved = (reason: string): Coverage => ({ kind: 'not-observed', reason });
const humanOnly = (reason: string): Coverage => ({ kind: 'human-only', reason });

// Hosted control routes carry control state only. Message bodies travel through the
// messaging relay and never enter a control request in any wired flow, so a canary
// scan of these routes is vacuous rather than evidence.
const CONTROL_NO_CONTENT = 'hosted control state only; no wired flow carries a message body through control, and no disposable Netlify deployment was available';
const CLAUDE_UNCOMPOSED = 'the shipped CLI composes no Claude session client (cli/main.ts), so these tools answer only through a Claude session this suite cannot start';
const OPENCODE_UNCOMPOSED = 'the shipped plugin entry composes no transport (unavailableOpenCodeDependencies), so it can reach no content to test';
const ADAPTER_UNDRIVEN = 'not driven: the review gate was exercised through the Codex adapter only. The dispatcher hands every adapter the same approved job, but this adapter\'s own behaviour (including any file access) was not observed';
const HOOK_RENDERS_CLI = 'hook renders what `khala claude`/`khala codex-hook` returns; no live harness session was started, so hook output itself was not captured';
const DISCOVERY_UNMOUNTED = 'internal discovery routes are mounted only with a discovery port; they return channel listings and access state, and were not mounted here';

/**
 * The checked inventory. Adding a surface to the product without adding it here
 * fails `inventory.test.ts`; removing one here that is still registered fails too.
 */
export const SURFACE_INVENTORY: Readonly<Record<string, Coverage>> = {
  // Default MCP server (`khala mcp-serve`). Every tool result may append a channel batch.
  'mcp-tool:khala_send': probe('mcp-serve'),
  'mcp-tool:khala_read': probe('mcp-serve'),
  'mcp-tool:khala_listening_mode': probe('mcp-serve'),
  'mcp-tool:khala_list_channels': probe('mcp-serve'),
  'mcp-tool:khala_list_agents': probe('mcp-serve'),
  'mcp-tool:khala_request_channel_access': probe('mcp-serve'),
  'mcp-tool:khala_channel_access_status': probe('mcp-serve'),
  'mcp-tool:khala_pair': probe('mcp-serve'),
  'mcp-tool:khala_create_channel': probe('mcp-serve'),
  'mcp-tool:khala_channel_create_status': probe('mcp-serve'),
  // Claude-bound MCP server (`KHALA_MCP_HARNESS=claude`).
  'claude-mcp-tool:khala_send': notObserved(CLAUDE_UNCOMPOSED),
  'claude-mcp-tool:khala_read': notObserved(CLAUDE_UNCOMPOSED),
  'claude-mcp-tool:khala_status': notObserved(CLAUDE_UNCOMPOSED),
  'claude-mcp-tool:khala_list_channels': notObserved(CLAUDE_UNCOMPOSED),
  'claude-mcp-tool:khala_list_agents': notObserved(CLAUDE_UNCOMPOSED),
  'claude-mcp-tool:khala_request_channel_access': notObserved(CLAUDE_UNCOMPOSED),
  'claude-mcp-tool:khala_channel_access_status': notObserved(CLAUDE_UNCOMPOSED),
  // OpenCode plugin tools, as shipped.
  'opencode-tool:khala_read': notObserved(OPENCODE_UNCOMPOSED),
  'opencode-tool:khala_send': notObserved(OPENCODE_UNCOMPOSED),
  // Agent CLI commands.
  'cli:connect': probe('agent-cli'),
  'cli:listen': probe('agent-cli'),
  'cli:mode': probe('agent-cli'),
  'cli:read': probe('agent-cli'),
  'cli:send': probe('agent-cli'),
  'cli:status': probe('agent-cli'),
  'cli:mcp-serve': probe('mcp-serve'),
  'cli:channels': probe('agent-cli'),
  'cli:agents': probe('agent-cli'),
  'cli:internal': notObserved('launches or deletes a local channel for the human operator; exercised only through its loopback server routes here'),
  'cli:codex-hook': probe('agent-cli'),
  'cli:join': probe('agent-cli'),
  'cli:claude': probe('agent-cli'),
  'cli:pair': probe('agent-cli'),
  'claude-op:pull': probe('agent-cli'),
  'claude-op:read': probe('agent-cli'),
  'claude-op:send': probe('agent-cli'),
  'claude-op:status': probe('agent-cli'),
  'claude-op:mode': probe('agent-cli'),
  'claude-op:pending': probe('agent-cli'),
  'claude-op:hook': probe('agent-cli'),
  // Native hook events.
  'hook-claude:UserPromptSubmit': notObserved(HOOK_RENDERS_CLI),
  'hook-claude:PostToolUse': notObserved(HOOK_RENDERS_CLI),
  'hook-claude:Stop': notObserved(HOOK_RENDERS_CLI),
  'hook-claude:SessionEnd': notObserved(HOOK_RENDERS_CLI),
  'hook-codex:PreToolUse': probe('agent-cli'),
  'hook-codex:PostToolUse': probe('agent-cli'),
  'hook-codex:UserPromptSubmit': probe('agent-cli'),
  'hook-codex:Stop': probe('agent-cli'),
  'hook-codex-app:PostToolUse': notObserved('Codex app hooks need a Codex app thread; the shipped hook reads the same inbox `khala read` does'),
  'hook-codex-app:Stop': notObserved('Codex app hooks need a Codex app thread; the shipped hook reads the same inbox `khala read` does'),
  // Loopback server of internal mode. Shared routes accept both the human session and a binding.
  'http-internal:GET /__khala/bootstrap': probe('internal-http'),
  'http-internal:GET /__khala/bootstrap.js': probe('internal-http'),
  'http-internal:POST /__khala/session': probe('internal-http'),
  'http-internal:GET /api/v1/session': probe('internal-http'),
  'http-internal:POST /api/v1/channels': probe('internal-http'),
  'http-internal:GET /api/v1/channels/:channelId': probe('internal-http'),
  'http-internal:GET /api/v1/channels/:channelId/timeline': probe('internal-http'),
  'http-internal:POST /api/v1/channels/:channelId/messages': probe('internal-http'),
  'http-internal:GET /api/v1/channels/:channelId/hints': probe('internal-http'),
  'http-internal:GET /api/v1/agent/binding': probe('internal-http'),
  'http-internal:GET /api/v1/channels/:channelId/releases': probe('internal-http'),
  'http-internal:GET /api/v1/channels/:channelId/receipts': probe('internal-http'),
  'http-internal:GET /channels/:channelId': probe('internal-http'),
  'http-internal:GET /channels/:channelId/settings': probe('internal-http'),
  'http-internal:GET /channel-requests': probe('internal-http'),
  'http-internal:GET /channel-requests/:handle': probe('internal-http'),
  // Internal discovery routes.
  ...Object.fromEntries(Object.values(DISCOVERY_ROUTES).map(route => [
    `http-internal:${route.method} ${route.path}`,
    route.path.startsWith('/api/human/') || route.path.startsWith('/api/internal/')
      ? humanOnly('human or launcher route; the agent credential is refused by role')
      : notObserved(DISCOVERY_UNMOUNTED),
  ])),
  // Hosted control routes (Netlify). Human routes are owner-authenticated; agent routes carry control state only.
  ...Object.fromEntries([
    'GET /api/human/auth/login', 'GET /api/human/auth/callback', 'GET /api/human/me', 'POST /api/human/auth/logout',
    'POST /api/human/invitations/share', 'GET /api/human/invitations/inspect', 'POST /api/human/invitations/admit',
    'POST /api/human/messaging/session', 'POST /api/human/messaging/participants', 'POST /api/human/pairing/request',
    'GET /api/human/pairing/request', 'POST /api/human/pairing/decision', 'GET /api/human/channel-access/inbox',
    'POST /api/human/channel-access/decision', 'POST /api/human/channel-access/mute',
    'GET /api/human/channel-discovery/bootstrap/authorize', 'POST /api/human/channel-discovery/bootstrap/authorize',
    'PUT /api/human/channel-discovery/settings', 'POST /api/human/channel-discovery/allowlist',
    'PUT /api/human/channel-discovery/rollout',
  ].map(route => [`http-control:${route}`, humanOnly('owner-authenticated hosted control route')])),
  ...Object.fromEntries([
    'GET /api/agent/status', 'POST /api/agent/pairing/claim', 'POST /api/agent/pairing/result',
    'POST /api/agent/channel-access/request', 'POST /api/agent/channel-access/create', 'GET /api/agent/channel-access/status',
    'POST /api/agent/channel-access/exchange', 'POST /api/agent/channel-access/ready', 'POST /api/agent/channel-access/resume',
    'POST /api/agent/channel-discovery/bootstrap/token', 'GET /api/agent/channels',
  ].map(route => [`http-control:${route}`, notObserved(CONTROL_NO_CONTENT)])),
  // Harness adapters. Only the Codex adapter is driven, over its fake app-server.
  'harness-adapter:claude': notObserved(ADAPTER_UNDRIVEN),
  'harness-adapter:claude-app': notObserved(ADAPTER_UNDRIVEN),
  'harness-adapter:codex': probe('dispatcher-gate'),
  'harness-adapter:codex-app': notObserved(ADAPTER_UNDRIVEN),
  'harness-adapter:cursor': notObserved(ADAPTER_UNDRIVEN),
  'harness-adapter:opencode': notObserved(ADAPTER_UNDRIVEN),
};

/**
 * Tools the frozen Claude plugin contract names that no tool registry serves. They
 * cannot reach a model today; registering one moves it into the discovered set,
 * where the inventory audit then demands a coverage decision.
 */
export const DECLARED_UNREGISTERED_TOOLS: Readonly<Record<string, string>> = {};

/**
 * The internal server's route table is module-private, so its entries are read from
 * the source. A route registered outside `ROUTES` would not be seen here.
 */
export function internalServerRoutes(): string[] {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'apps/internal/src/server/channel-server.ts'), 'utf8');
  const table = /const ROUTES = \{([\s\S]*?)\n\} as const/.exec(source)?.[1];
  if (table === undefined) throw new Error('internal server route table not found; update the inventory scan');
  const constants: Record<string, string> = {};
  for (const file of fs.readdirSync(path.join(REPO_ROOT, 'apps/internal/src/server'))) {
    if (!file.endsWith('.ts')) continue;
    const text = fs.readFileSync(path.join(REPO_ROOT, 'apps/internal/src/server', file), 'utf8');
    for (const match of text.matchAll(/export const ([A-Z_]+_ROUTE) = '([^']+)'/g)) constants[match[1]!] = match[2]!;
  }
  const routes: string[] = [];
  for (const match of table.matchAll(/method: '(GET|POST)', path: ('([^']+)'|[A-Z_]+)/g)) {
    const routePath = match[3] ?? constants[match[2]!];
    if (routePath === undefined) throw new Error(`internal server route constant ${match[2]} not found`);
    routes.push(`${match[1]} ${routePath}`);
  }
  return routes;
}

/**
 * Where the encrypted relay (Matrix/Synapse) is reached from: relay or E2EE SDK
 * dependencies in runtime manifests, and source paths named for a relay, homeserver or
 * Matrix. Today that is the human browser flow and its control session issuer
 * (KHA-132). This is a heuristic, not a proof of absence: a relay client under another
 * name, for example one built directly on `libsodium-wrappers`, would not appear.
 */
export function relayAdapterEvidence(): string[] {
  const manifests = ['packages/messaging', 'packages/connector', 'apps/connector', 'apps/control', 'apps/web'];
  const dependencies = manifests.flatMap(dir => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    return Object.keys(manifest.dependencies ?? {}).filter(name => /matrix|megolm|olm\b|mls|relay/i.test(name)).map(name => `${dir}: ${name}`);
  });
  const paths = manifests.flatMap(dir => listSourcePaths(path.join(REPO_ROOT, dir, 'src')))
    .map(file => path.relative(REPO_ROOT, file))
    .filter(file => /(^|\/)[^/]*(relay|homeserver|matrix)[^/]*(\/|\.ts$)/i.test(file) && !file.endsWith('.test.ts'));
  return [...dependencies, ...paths];
}

function listSourcePaths(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    if (entry.name === 'node_modules') return [];
    return entry.isDirectory() ? [full + path.sep, ...listSourcePaths(full)] : [full];
  });
}

/** Harness adapter directories named by the package's export map. */
export function harnessAdapters(): string[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/harnesses/package.json'), 'utf8')) as {
    exports: Record<string, string | null>;
  };
  return Object.entries(manifest.exports)
    .filter(([key, target]) => target !== null && key.endsWith('/*'))
    .map(([key]) => key.slice(2, -2));
}

/** Direct dependencies of the harness package; the dispatcher-gate argument needs contracts only. */
export function harnessDependencies(): string[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/harnesses/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(manifest.dependencies ?? {}).sort();
}

async function openCodeTools(): Promise<string[]> {
  const hooks = await createKhalaOpenCodeServer(unavailableOpenCodeDependencies())({
    client: {} as never,
    directory: REPO_ROOT,
  });
  return Object.keys(hooks.tool);
}

function claudeTools(): string[] {
  const refuse = async () => { throw new Error('inventory only'); };
  return createClaudeToolRegistry({ send: refuse, read: refuse, mode: refuse } as never)
    .definitions()
    .map(definition => (definition as { name: string }).name);
}

export type DiscoveredSurfaces = Readonly<{
  ids: readonly string[];
  /** Plugin tool names the frozen Claude contract declares. */
  declaredPluginTools: readonly string[];
}>;

/** Everything the built code registers, as surface IDs. */
export async function discoverSurfaces(): Promise<DiscoveredSurfaces> {
  const control = (await discoverRoutes(REPO_ROOT)).routeManifest
    .flatMap(route => route.methods.map(method => `http-control:${method} ${route.path}`));
  const ids = [
    ...MCP_TOOLS.map(tool => `mcp-tool:${tool.name}`),
    ...claudeTools().map(name => `claude-mcp-tool:${name}`),
    ...(await openCodeTools()).map(name => `opencode-tool:${name}`),
    ...CLI_COMMANDS.map(command => `cli:${command.name}`),
    ...CLAUDE_COMMAND_OPS.map(op => `claude-op:${op}`),
    ...Object.keys(FROZEN_HOOK_EVENTS).map(event => `hook-claude:${event}`),
    ...CODEX_HOOK_EVENTS.map(event => `hook-codex:${event}`),
    ...CODEX_APP_HOOK_EVENTS.map(event => `hook-codex-app:${event}`),
    ...internalServerRoutes().map(route => `http-internal:${route}`),
    ...Object.values(DISCOVERY_ROUTES).map(route => `http-internal:${route.method} ${route.path}`),
    ...control,
    ...harnessAdapters().map(name => `harness-adapter:${name}`),
  ];
  return { ids: [...new Set(ids)].sort(), declaredPluginTools: [...FROZEN_MCP_TOOLS] };
}

export type InventoryAudit = Readonly<{
  /** Registered but absent from the checked inventory: a new surface without a boundary decision. */
  unlisted: readonly string[];
  /** Listed but no longer registered. */
  stale: readonly string[];
}>;

/** Compares discovered surfaces with the checked inventory. */
export function auditInventory(discovered: readonly string[], inventory: Readonly<Record<string, Coverage>>): InventoryAudit {
  const found = new Set(discovered);
  return {
    unlisted: discovered.filter(id => !(id in inventory)),
    stale: Object.keys(inventory).filter(id => !found.has(id)),
  };
}

/** Surface IDs a probe is responsible for. */
export function surfacesFor(probeId: ProbeId): string[] {
  return Object.entries(SURFACE_INVENTORY)
    .filter(([, coverage]) => coverage.kind === 'probe' && coverage.probe === probeId)
    .map(([id]) => id)
    .sort();
}
