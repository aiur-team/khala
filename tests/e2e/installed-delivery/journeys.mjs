// One delivery journey per harness Khala installs an entry for. Each sets up a fresh
// machine with the packed package, starts the installed `khala internal`, and drives
// only that harness's installed entry, read back from its harness config: join, the
// owner's approval, one delivered message, `khala_read`, the next call advancing the
// agent's read cursor, and the owner's Stop ending delivery. A harness whose route is
// intentionally unproven must refuse honestly instead. Every failure is a
// `DeliveryFailure` naming the harness, so a broken entry fails the suite under that
// harness's name. A delivering journey resolves to whether the owner's receipts show
// the agent acknowledged the delivered message, which the suite asserts as todo until
// internal mode records acknowledgements (#442).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { approveCodexHooksNatively } from '../../integration/agent-setup/harness.mjs';
import {
  VERSIONS, agentCli, claudeEntries, codexEntries, cursorEntries, eventually, mcpSession, openCodeEntries, openCodeSession,
  resultText, runHook, setUpMachine, startInternal, step,
} from './world.mjs';

/** What every installed Khala MCP entry serves and answers as. */
const READ_TOOL = 'khala_read';
const SEND_TOOL = 'khala_send';
const SERVER_NAME = 'khala-agent-cli';

const batchToken = text => /batchToken: ([^\s\\]+)/.exec(text)?.[1] ?? null;

/** Discovery and `join` for one session with the installed CLI, as the agent's shell runs them. */
function join(install, machine, harness, sessionId, channelUrl) {
  const issued = agentCli(install, machine, ['internal', 'discovery', '--harness', harness, '--session', sessionId]);
  assert.equal(issued.status, 0, `discovery failed: ${issued.stderr}`);
  const joined = () => agentCli(install, machine, ['--internal-descriptor', issued.json.descriptorPath, 'join', channelUrl]).json;
  return { first: joined(), again: joined };
}

/**
 * Whether the owner's receipts show `agent_acknowledged` for the delivered message,
 * given a moment to project. Returned rather than asserted, so the suite can mark it
 * todo until #442 lands without skipping the rest of the journey.
 */
async function ownerAcknowledgement(launch, eventId) {
  const deadline = Date.now() + 3_000;
  for (;;) {
    if ((await launch.owner.acknowledgedEvents()).includes(eventId)) return { eventId, acknowledged: true };
    if (Date.now() > deadline) return { eventId, acknowledged: false };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** The installed MCP entry answers as Khala and serves its read and send tools. */
async function assertKhalaServer(mcp) {
  const initialized = await mcp.initialize();
  assert.equal(initialized.serverInfo?.name, SERVER_NAME, `the entry is not Khala's server: ${JSON.stringify(initialized.serverInfo)}`);
  const tools = await mcp.tools();
  for (const tool of [READ_TOOL, SEND_TOOL]) assert.ok(tools.includes(tool), `the entry serves no ${tool}: ${tools}`);
}

// ---------------------------------------------------------------------------

/**
 * Claude Code: the plugin's `.mcp.json` server, launched with the session in
 * `CLAUDE_CODE_SESSION_ID`, and its hooks run through `sh -c` with `CLAUDE_PLUGIN_ROOT`.
 * The session asks through `khala_request_channel_access`; the grant settles at the
 * installed Stop hook. `khala_read` delivers and the next Khala call advances the cursor.
 */
async function claude({ machine, launch }) {
  const h = 'claude';
  const sessionId = 'claude-installed-session';
  const entries = claudeEntries(machine);
  const hookEnv = { CLAUDE_PLUGIN_ROOT: entries.pluginRoot };
  const hook = (event, extra = {}) => runHook(machine, entries.hooks[event][0].command,
    { hook_event_name: event, session_id: sessionId, ...extra }, { env: hookEnv });
  const mcp = mcpSession(machine, entries.mcp, { CLAUDE_CODE_SESSION_ID: sessionId });
  try {
    await step(h, 'the plugin MCP entry starts as Khala', () => assertKhalaServer(mcp));
    const operationId = await step(h, 'join files an access request', async () => {
      const requested = (await mcp.call('khala_request_channel_access', { target: launch.channelUrl })).structuredContent;
      assert.equal(requested?.outcome, 'pending_owner', JSON.stringify(requested));
      return requested.operationId;
    });
    await step(h, 'the owner approves the request', () => launch.owner.approve(h));
    await step(h, 'the installed Stop hook settles the grant', async () => {
      const stopped = await hook('Stop', { stop_hook_active: false });
      assert.equal(stopped.code, 0, stopped.stderr);
      assert.match(stopped.stdout, /granted this session's access request/, `Stop hook output: ${stopped.stdout}${stopped.stderr}`);
      const status = (await mcp.call('khala_channel_access_status', { operationId })).structuredContent;
      assert.equal(status?.outcome, 'connected', JSON.stringify(status));
    });
    const deliveredId = await launch.owner.say('installed delivery for claude');
    await step(h, 'khala_read delivers the message', async () => {
      const read = resultText(await mcp.call(READ_TOOL));
      assert.match(read, /installed delivery for claude/, read);
    });
    await step(h, "the next Khala call advances the agent's read cursor", async () => {
      await mcp.call('khala_status');
      assert.deepEqual((await mcp.call(READ_TOOL)).structuredContent, { kind: 'empty' });
    });
    const acknowledgement = await step(h, "the owner's receipts are read", () => ownerAcknowledgement(launch, deliveredId));
    await step(h, 'the reply reaches the channel', async () => {
      assert.equal((await mcp.call(SEND_TOOL, { message: 'claude replies' })).structuredContent?.kind, 'accepted');
      assert.match(await launch.owner.timeline(), /claude replies/);
    });
    await step(h, 'Stop ends delivery', async () => {
      const stopped = await launch.owner.stopAll();
      assert.deepEqual(stopped.stopped.map(entry => entry.harness), [h]);
      await launch.owner.say('after Stop for claude');
      assert.deepEqual((await mcp.call(READ_TOOL)).structuredContent, { kind: 'refused', code: 'session_not_bound' });
      const after = await hook('PostToolUse', { tool_name: 'Bash' });
      assert.equal(after.stdout, '', `a hook delivered after Stop: ${after.stdout}`);
    });
    return acknowledgement;
  } finally {
    await mcp.close();
  }
}

/**
 * Codex: `mcp_servers.khala` from `config.toml`, sent each call's thread in
 * `_meta.threadId`, and the `hooks.json` handlers, trusted once in Codex's review
 * dialog. The agent joins with the CLI under `$CODEX_THREAD_ID`, as its skill says.
 */
async function codex({ install, machine, launch }) {
  const h = 'codex';
  const thread = 'codex-installed-thread';
  const meta = { threadId: thread };
  approveCodexHooksNatively(machine);
  const entries = codexEntries(machine);
  const hook = (event, extra = {}) => runHook(machine, entries.hooks[event][0].command,
    { hook_event_name: event, session_id: thread, turn_id: 'turn-1', ...extra });
  const mcp = mcpSession(machine, entries.mcp);
  try {
    await step(h, 'the MCP entry starts as Khala', () => assertKhalaServer(mcp));
    const joined = await step(h, 'join files an access request', () => {
      const result = join(install, machine, h, thread, launch.channelUrl);
      assert.equal(result.first?.outcome, 'pending_owner', JSON.stringify(result.first));
      return result;
    });
    await step(h, 'the owner approves the request', () => launch.owner.approve(h));
    await step(h, 'the approved join connects', () => assert.equal(joined.again()?.outcome, 'connected'));
    const deliveredId = await launch.owner.say('installed delivery for codex');
    await step(h, 'the installed UserPromptSubmit hook delivers the message', async () => {
      const delivered = await hook('UserPromptSubmit', { prompt: 'continue' });
      assert.equal(delivered.code, 0, delivered.stderr);
      assert.match(delivered.stdout, /installed delivery for codex/, `hook output: ${delivered.stdout}${delivered.stderr}`);
    });
    const token = await step(h, 'khala_read returns the delivered batch until it is acknowledged', async () => {
      const read = resultText(await mcp.call(READ_TOOL, {}, meta));
      assert.match(read, /installed delivery for codex/, read);
      const first = batchToken(read);
      assert.ok(first, `no batch token in ${read}`);
      assert.equal(batchToken(resultText(await mcp.call(READ_TOOL, {}, meta))), first, 'an unacknowledged batch is offered again');
      return first;
    });
    await step(h, "the next call advances the agent's read cursor", async () => {
      const sent = (await mcp.call(SEND_TOOL, { message: 'codex replies', ackBatchToken: token }, meta)).structuredContent;
      assert.equal(sent?.kind, 'accepted', JSON.stringify(sent));
      assert.deepEqual((await mcp.call(READ_TOOL, {}, meta)).structuredContent, { kind: 'empty' });
      assert.match(await launch.owner.timeline(), /codex replies/);
    });
    const acknowledgement = await step(h, "the owner's receipts are read", () => ownerAcknowledgement(launch, deliveredId));
    await step(h, 'Stop ends delivery', async () => {
      const stopped = await launch.owner.stopAll();
      assert.deepEqual(stopped.stopped.map(entry => entry.harness), [h]);
      await launch.owner.say('after Stop for codex');
      assert.deepEqual((await mcp.call(READ_TOOL, {}, meta)).structuredContent, { kind: 'refused', code: 'not_connected' });
      const after = await hook('UserPromptSubmit', { prompt: 'continue' });
      assert.doesNotMatch(after.stdout, /after Stop/, 'a hook delivered after Stop');
    });
    return acknowledgement;
  } finally {
    await mcp.close();
  }
}

/**
 * OpenCode: the `plugin` module `opencode.json` names, loaded into an OpenCode
 * stand-in at the tested version with one idle session. The agent joins with the CLI
 * under its session ID; the plugin wakes the idle session with `promptAsync`.
 */
async function opencode({ install, machine, launch }) {
  const h = 'opencode';
  const sessionId = 'ses_installed_opencode';
  const entries = openCodeEntries(machine);
  const version = VERSIONS.opencode;
  const session = await step(h, 'OpenCode loads the installed plugin', async () => {
    const loaded = await openCodeSession(machine, entries.plugin, { sessionId, version });
    for (const tool of [READ_TOOL, SEND_TOOL]) assert.ok(loaded.tools.includes(tool), `the plugin serves no ${tool}: ${loaded.tools}`);
    return loaded;
  });
  try {
    const joined = await step(h, 'join files an access request', () => {
      const result = join(install, machine, h, sessionId, launch.channelUrl);
      assert.equal(result.first?.outcome, 'pending_owner', JSON.stringify(result.first));
      return result;
    });
    await step(h, 'the owner approves the request', () => launch.owner.approve(h));
    await step(h, 'the approved join connects', () => assert.equal(joined.again()?.outcome, 'connected'));
    // The `join` ran in the agent's bash tool: the first hook the plugin sees after it.
    await session.afterTool('bash');
    const deliveredId = await launch.owner.say('installed delivery for opencode');
    const delivered = await step(h, 'the plugin delivers the message to the idle session', async () => {
      const prompts = await eventually(() => session.prompts, list => list.length > 0, { what: 'promptAsync' });
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0].sessionID, sessionId);
      assert.match(prompts[0].text, /installed delivery for opencode/);
      return prompts[0].text;
    });
    const token = await step(h, 'khala_read returns the delivered batch', async () => {
      const read = await session.tool(READ_TOOL);
      assert.match(read, /installed delivery for opencode/, read);
      const readToken = /"batchToken":"([^"]+)"/.exec(read)?.[1];
      assert.equal(readToken, /"batchToken":"([^"]+)"/.exec(delivered)?.[1], 'khala_read returns the batch the plugin delivered');
      return readToken;
    });
    await step(h, "the next call advances the agent's read cursor", async () => {
      const sent = JSON.parse(await session.tool(SEND_TOOL, { message: 'opencode replies', ackBatchToken: token }));
      assert.equal(sent.kind, 'accepted', JSON.stringify(sent));
      assert.deepEqual(JSON.parse(await session.tool(READ_TOOL)), { kind: 'empty' });
      assert.match(await launch.owner.timeline(), /opencode replies/);
    });
    const acknowledgement = await step(h, "the owner's receipts are read", () => ownerAcknowledgement(launch, deliveredId));
    await step(h, 'Stop ends delivery', async () => {
      const stopped = await launch.owner.stopAll();
      assert.deepEqual(stopped.stopped.map(entry => entry.harness), [h]);
      await launch.owner.say('after Stop for opencode');
      await session.afterTool('bash');
      assert.deepEqual(JSON.parse(await session.tool(READ_TOOL)), { kind: 'refused', code: 'not_connected' });
      await new Promise(resolve => setTimeout(resolve, 1_500));
      assert.equal(session.prompts.length, 1, 'the plugin prompted after Stop');
    });
    return acknowledgement;
  } finally {
    await session.close();
  }
}

/**
 * Cursor: every listening mode is unproven (decisions 34 and 37), so setup installs only
 * the `~/.cursor/mcp.json` entry and must say so. The honest refusal is asserted end to
 * end: setup and the owner's view claim no delivery, and the installed entry, which
 * Cursor runs without naming its session, delivers nothing even to an approved session.
 */
async function cursor({ install, machine, launch, status }) {
  const h = 'cursor';
  const sessionId = 'cursor-installed-chat';
  const entries = cursorEntries(machine);
  await step(h, 'setup reports the route unproven', () => {
    const reported = status.harnesses.find(entry => entry.harness === h);
    assert.equal(reported.route, 'unknown');
    const notice = status.diagnostics.find(entry => entry.harness === h && entry.code === 'cursor_delivery_unproven');
    assert.match(notice?.message ?? '', /Idle agents receive messages only at their next turn/);
  });
  const mcp = mcpSession(machine, entries.mcp);
  try {
    await step(h, 'the MCP entry starts as Khala', () => assertKhalaServer(mcp));
    const joined = await step(h, 'join files an access request', () => {
      const result = join(install, machine, h, sessionId, launch.channelUrl);
      assert.equal(result.first?.outcome, 'pending_owner', JSON.stringify(result.first));
      return result;
    });
    await step(h, 'the owner approves the request', () => launch.owner.approve(h));
    await step(h, 'the approved join connects', () => assert.equal(joined.again()?.outcome, 'connected'));
    await step(h, 'the owner sees no delivery claimed', async () => {
      const [binding] = await launch.owner.bindings();
      assert.equal(binding.binding.harness, h);
      assert.equal(binding.idleDelivery, 'unproven');
      assert.equal(binding.view.effective, null);
      for (const [mode, support] of Object.entries(binding.view.support)) assert.notEqual(support.status, 'proven', `${mode} is claimed proven`);
    });
    await launch.owner.say('installed delivery for cursor');
    await step(h, 'the installed entry refuses instead of delivering', async () => {
      const read = await mcp.call(READ_TOOL);
      assert.deepEqual(read.structuredContent, { kind: 'refused', code: 'not_connected' });
      assert.doesNotMatch(resultText(read), /installed delivery for cursor/);
      assert.deepEqual((await mcp.call(SEND_TOOL, { message: 'cursor replies' })).structuredContent, { kind: 'refused', code: 'not_connected' });
      assert.doesNotMatch(await launch.owner.timeline(), /cursor replies/);
    });
    await step(h, 'Stop ends the binding', async () => {
      const stopped = await launch.owner.stopAll();
      assert.deepEqual(stopped.stopped.map(entry => entry.harness), [h]);
      assert.deepEqual((await mcp.call(READ_TOOL)).structuredContent, { kind: 'refused', code: 'not_connected' });
    });
  } finally {
    await mcp.close();
  }
}

/** Every harness setup installs an entry for, with the journey that proves it. */
export const JOURNEYS = Object.freeze({ claude, codex, opencode, cursor });

/**
 * Runs one harness's journey on a fresh machine and launch. A delivering journey
 * resolves to the owner's acknowledgement evidence; Cursor's resolves to nothing. With `stub`, that harness's
 * installed entries are first rewritten, in its own config, to ones that bind nothing:
 * the wrong-implementation check.
 */
export async function runJourney(install, harness, { stub = false } = {}) {
  const { machine, status } = await step(harness, 'khala setup', () => setUpMachine(install));
  if (stub) STUBS[harness](machine);
  const launch = await step(harness, 'khala internal starts', () => startInternal(install, machine));
  try {
    // Any failure outside a named step still names the harness.
    return await step(harness, 'journey', () => JOURNEYS[harness]({ install, machine, launch, status }));
  } finally {
    await launch.stop();
  }
}

// ---------------------------------------------------------------------------
// Stubs that bind nothing, written over one harness's installed entries.

// An MCP server that answers `initialize` as something other than Khala, lists no tools
// and refuses every call. Its shebang names Node, so it runs with no node on PATH.
const STUB_SERVER = `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  const result = message.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } }
    : message.method === 'tools/list' ? { tools: [] }
    : { content: [{ type: 'text', text: '{"kind":"refused","code":"not_connected"}' }], structuredContent: { kind: 'refused', code: 'not_connected' }, isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`;

// An OpenCode plugin whose tools are bound to nothing, as unavailableOpenCodeDependencies() was (#430).
const STUB_PLUGIN = `
const refused = async () => JSON.stringify({ kind: 'refused', code: 'not_connected' });
export default {
  id: 'khala',
  server: async () => ({
    tool: { khala_read: { description: '', args: {}, execute: refused }, khala_send: { description: '', args: {}, execute: refused } },
    'tool.execute.after': async () => {},
    'experimental.chat.messages.transform': async () => {},
    event: async () => {},
    dispose: async () => {},
  }),
};
`;

function writeStub(machine, name, text, mode) {
  const file = path.join(machine.root, 'stubs', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  return file;
}

const stubServer = machine => writeStub(machine, 'mcp-stub.cjs', `#!${process.execPath}\n${STUB_SERVER}`, 0o755);

/** Rewrites a JSON config file in place; setup may have left it read-only. */
function rewriteJson(file, change) {
  fs.chmodSync(file, 0o600);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(config);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

/** Every command hook in a `hooks.json` becomes one that does nothing. */
const stubHookCommands = config => {
  for (const groups of Object.values(config.hooks)) for (const group of groups) for (const handler of group.hooks) handler.command = 'exit 0';
};

/** For each harness, overwrites its installed entries, where its config holds them, with stubs. */
const STUBS = Object.freeze({
  claude(machine) {
    const { pluginRoot } = claudeEntries(machine);
    rewriteJson(path.join(pluginRoot, '.mcp.json'), config => { config.mcpServers.khala = { command: stubServer(machine), args: [] }; });
    rewriteJson(path.join(pluginRoot, 'hooks', 'hooks.json'), stubHookCommands);
  },
  codex(machine) {
    const configPath = path.join(machine.home, '.codex', 'config.toml');
    const { mcp } = codexEntries(machine);
    const toml = fs.readFileSync(configPath, 'utf8');
    const entry = `command = ${JSON.stringify(mcp.command)}`;
    assert.ok(toml.includes(entry), 'the Codex MCP entry is where setup wrote it');
    fs.writeFileSync(configPath, toml.replace(entry, `command = ${JSON.stringify(stubServer(machine))}`).replace('args = ["mcp-serve"]', 'args = []'));
    rewriteJson(path.join(machine.home, '.codex', 'hooks.json'), stubHookCommands);
  },
  opencode(machine) {
    const plugin = pathToFileURL(writeStub(machine, 'opencode.js', STUB_PLUGIN, 0o644)).href;
    rewriteJson(path.join(machine.home, '.config', 'opencode', 'opencode.json'), config => {
      config.plugin = config.plugin.map(entry => (entry.endsWith('/opencode.js') ? plugin : entry));
    });
  },
  cursor(machine) {
    rewriteJson(path.join(machine.home, '.cursor', 'mcp.json'), config => { config.mcpServers.khala = { command: stubServer(machine), args: [] }; });
  },
});
