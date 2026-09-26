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
import { BINDING_MODE_ROUTES } from '../../../apps/internal/src/server/binding-mode';
import { DISCOVERY_ROUTES } from '../../../apps/internal/src/server/discovery';
import { MAKE_EXTERNAL_ROUTES } from '../../../apps/internal/src/server/make-external';
import { STOP_ROUTE } from '../../../apps/internal/src/server/stop/route';
import { CLI_COMMANDS } from '../../../packages/agent-cli/src/cli/registry';
import { CODEX_APP_HOOK_EVENTS } from '../../../packages/agent-cli/src/codex-app/hook';
import { CODEX_HOOK_EVENTS } from '../../../packages/agent-cli/src/codex/hook';
import { CLAUDE_SESSION_PATH } from '../../../packages/agent-cli/src/composition/claude-session-http';
import { CLAUDE_COMMAND_OPS } from '../../../packages/agent-cli/src/composition/claude-command';
import { createClaudeToolRegistry } from '../../../packages/agent-cli/src/composition/claude-mcp';
import { MCP_TOOLS } from '../../../packages/agent-cli/src/mcp/registry';
import { createKhalaOpenCodeServer, unavailableOpenCodeDependencies } from '../../../packages/agent-cli/src/opencode/plugin';
import { FROZEN_HOOK_EVENTS, FROZEN_MCP_TOOLS } from '../../../packages/claude-plugin/src/contract';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Probes implemented in `airlock.test.ts`. */
export const PROBES = ['internal-http', 'agent-cli', 'mcp-serve', 'claude-session', 'internal-discovery', 'dispatcher-gate'] as const;
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
const OPENCODE_UNCOMPOSED = 'the shipped plugin entry composes no transport (unavailableOpenCodeDependencies), so it can reach no content to test';
const ADAPTER_UNDRIVEN = 'not driven: the review gate was exercised through the Codex adapter only. The dispatcher hands every adapter the same approved job, but this adapter\'s own behaviour (including any file access) was not observed';
const HOOK_RENDERS_CLI = 'hook renders what `khala claude`/`khala codex-hook` returns; no live harness session was started, so hook output itself was not captured';
const SETUP_UNCOMPOSED = 'installs or removes harness configuration from the packaged payload and reads no channel state; the test composition has no payload, so the command was not driven';
/**
 * Commands whose only transport in the shipped CLI is the hosted client, which
 * `cli/main.ts` composes as `createUnavailableClient`. They refuse `--internal-descriptor`
 * as `invalid_arguments`. With valid
 * arguments they refuse before any channel state; `airlock.test.ts` asserts each exact
 * refusal, so composing a transport for one fails the suite until it is probed.
 */
export const CLI_UNCOMPOSED = 'the shipped CLI composes no transport for this command (hosted client unavailable; `--internal-descriptor` refused), so it reaches no channel state; its refusal with valid arguments is asserted, not its content path';

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
  'claude-mcp-tool:khala_send': probe('claude-session'),
  'claude-mcp-tool:khala_read': probe('claude-session'),
  'claude-mcp-tool:khala_status': probe('claude-session'),
  'claude-mcp-tool:khala_mode_get': probe('claude-session'),
  'claude-mcp-tool:khala_mode_set': probe('claude-session'),
  'claude-mcp-tool:khala_list_channels': probe('claude-session'),
  'claude-mcp-tool:khala_list_agents': probe('claude-session'),
  'claude-mcp-tool:khala_request_channel_access': probe('claude-session'),
  'claude-mcp-tool:khala_channel_access_status': probe('claude-session'),
  'claude-mcp-tool:khala_create_channel': probe('claude-session'),
  // OpenCode plugin tools, as shipped.
  'opencode-tool:khala_read': notObserved(OPENCODE_UNCOMPOSED),
  'opencode-tool:khala_send': notObserved(OPENCODE_UNCOMPOSED),
  // Agent CLI commands.
  'cli:connect': notObserved(CLI_UNCOMPOSED),
  'cli:listen': probe('agent-cli'),
  'cli:mode': probe('agent-cli'),
  'cli:read': probe('agent-cli'),
  'cli:send': probe('agent-cli'),
  'cli:status': probe('agent-cli'),
  'cli:mcp-serve': probe('mcp-serve'),
  'cli:channels': notObserved(CLI_UNCOMPOSED),
  'cli:agents': notObserved(CLI_UNCOMPOSED),
  'cli:internal': notObserved('launches, exports or deletes a local channel for the human operator; its runtime (`create`, `discovery`) runs in `launcher-world.ts`, but the command itself was not driven'),
  'cli:setup': notObserved(SETUP_UNCOMPOSED),
  'cli:remove': notObserved(SETUP_UNCOMPOSED),
  'cli:codex-hook': probe('agent-cli'),
  'cli:join': probe('internal-discovery'),
  'cli:claude': probe('claude-session'),
  'cli:pair': notObserved(CLI_UNCOMPOSED),
  'claude-op:pull': probe('claude-session'),
  'claude-op:read': probe('claude-session'),
  'claude-op:send': probe('claude-session'),
  'claude-op:status': probe('claude-session'),
  'claude-op:mode': probe('claude-session'),
  'claude-op:pending': probe('claude-session'),
  'claude-op:hook': probe('claude-session'),
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
  'http-internal:POST /api/v1/channels/:channelId/stop': probe('internal-http'),
  'http-internal:GET /api/v1/channels/:channelId/make-external': probe('internal-http'),
  'http-internal:POST /api/v1/channels/:channelId/make-external': probe('internal-http'),
  // Listening-mode control and pause: mode state only. The owner routes refuse a binding by role;
  // the agent routes act on the bearer's own binding and carry no message body.
  ...Object.fromEntries(BINDING_MODE_ROUTES.map(route => [`http-internal:${route.method} ${route.path}`, probe('internal-http')])),
  // Claude session route: the launch's transport capability only, driven through the launcher.
  'http-internal:POST /api/agent/claude/session': probe('claude-session'),
  'http-internal:GET /channels/:channelId': probe('internal-http'),
  'http-internal:GET /channels/:channelId/settings': probe('internal-http'),
  'http-internal:GET /channels/:channelId/make-external': probe('internal-http'),
  'http-internal:GET /channel-requests': probe('internal-http'),
  'http-internal:GET /channel-requests/:handle': probe('internal-http'),
  // Internal discovery routes, mounted by the real launcher. Human routes are probed with
  // the agent's transport and discovery capabilities; agent routes with its own.
  ...Object.fromEntries(Object.values(DISCOVERY_ROUTES).map(route => [
    `http-internal:${route.method} ${route.path}`, probe('internal-discovery'),
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
 * Route registrations in the internal server that `internalServerRoutes` accounts for
 * outside the `ROUTES` table. Any other `routes.push(...)` fails discovery, so a route
 * mounted from a new module cannot escape the audit.
 */
const KNOWN_ROUTE_PUSHES: ReadonlySet<string> = new Set([
  'STOP_ROUTE',
  // The launcher mounts the Claude session route at `CLAUDE_SESSION_PATH`.
  'agentSession',
  // Discovery routes are enumerated from `DISCOVERY_ROUTES`.
  '...discovery.routes',
  // Make-external journey routes are enumerated from `MAKE_EXTERNAL_ROUTES`.
  '...makeExternal.routes',
  // Listening-mode control and pause routes are enumerated from `BINDING_MODE_ROUTES`.
  '...BINDING_MODE_ROUTES',
  // App-shell documents are `ROUTES` entries.
  '...APP_DOCUMENT_ROUTES',
  // Static assets from a built manifest: public files, no channel state.
  "{ method: 'GET', path: route, template: 'asset', admission: 'public' }",
]);

/**
 * The internal server's route table is module-private, so its entries are read from
 * the source. Routes pushed from elsewhere must be listed in `KNOWN_ROUTE_PUSHES`.
 */
export function internalServerRoutes(
  source = fs.readFileSync(path.join(REPO_ROOT, 'apps/internal/src/server/channel-server.ts'), 'utf8'),
): string[] {
  const table = /const ROUTES = \{([\s\S]*?)\n\} as const/.exec(source)?.[1];
  if (table === undefined) throw new Error('internal server route table not found; update the inventory scan');
  const constants: Record<string, string> = {};
  for (const file of fs.readdirSync(path.join(REPO_ROOT, 'apps/internal/src/server'))) {
    if (!file.endsWith('.ts')) continue;
    const text = fs.readFileSync(path.join(REPO_ROOT, 'apps/internal/src/server', file), 'utf8');
    for (const match of text.matchAll(/export const ([A-Z_]+_ROUTE) = '([^']+)'/g)) constants[match[1]!] = match[2]!;
  }
  for (const match of source.matchAll(/routes\.push\(([\s\S]*?)\);/g)) {
    const pushed = match[1]!.trim();
    if (!pushed.startsWith('ROUTES.') && !KNOWN_ROUTE_PUSHES.has(pushed)) {
      throw new Error(`internal server registers an unaccounted route: routes.push(${pushed}); update the inventory scan`);
    }
  }
  const routes: string[] = [
    `${STOP_ROUTE.method} ${STOP_ROUTE.path}`, `POST ${CLAUDE_SESSION_PATH}`,
    ...Object.values(MAKE_EXTERNAL_ROUTES).map(route => `${route.method} ${route.path}`),
    ...BINDING_MODE_ROUTES.map(route => `${route.method} ${route.path}`),
  ];
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
