// One Cursor command hook for every event in hooks.json. Cursor sends the event
// on stdin and reads one JSON object from stdout; message bytes reach the model
// only through that stdout, never argv, env, or the event log.
import { randomBytes } from 'node:crypto';
import {
  CLOUD_SESSION, SESSION_ENV, bindingKey, frame, openCursorStore, recordCaller,
} from './session.mjs';

const store = await openCursorStore(process.env);
if (!store) process.exit(0);

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const input = JSON.parse(stdin);
const event = input.hook_event_name;
const conversationId = input.conversation_id;
if (typeof event !== 'string' || typeof conversationId !== 'string') process.exit(0);

const cloud = store.run.shape === 'cloud_task';
const common = {
  event,
  conversationId,
  generationId: input.generation_id ?? null,
  cursorVersion: input.cursor_version ?? process.env.CURSOR_VERSION ?? null,
  model: input.model ?? null,
};

const emit = value => process.stdout.write(JSON.stringify(value));

async function currentKey() {
  // Cloud agents run no sessionStart hook, so the first hook binds the task.
  const session = process.env[SESSION_ENV] ?? (cloud ? CLOUD_SESSION : null);
  if (session === null) return null;
  const key = bindingKey(conversationId, session);
  if (cloud && (await store.binding()) === null) await store.bind(key, 'first-hook');
  return key;
}

async function deliver(key, boundary, mode) {
  const { denied, releases } = await store.pull(key, boundary);
  if (denied || releases.length === 0) return null;
  await store.log('delivered', {
    ...common, sessionKey: key, mode, boundary, releaseIds: releases.map(item => item.releaseId),
  });
  return frame(releases);
}

if (event === 'sessionStart') {
  const background = input.is_background_agent === true;
  await store.log('hook', {
    ...common, sessionId: input.session_id ?? null, isBackgroundAgent: background, composerMode: input.composer_mode ?? null,
  });
  // A background agent is a different session from the person's chat; it never
  // binds, so it can neither receive nor acknowledge a batch.
  if (background || cloud) process.exit(0);
  const session = typeof input.session_id === 'string' ? input.session_id : randomBytes(6).toString('hex');
  await store.bind(bindingKey(conversationId, session), 'sessionStart');
  emit({ env: { [SESSION_ENV]: session } });
} else if (event === 'beforeSubmitPrompt') {
  // The person's turn starts. Only the fact is logged, never the prompt.
  await store.log('user-prompt', { ...common, sessionKey: await currentKey() });
} else if (event === 'preToolUse') {
  await store.log('tool-start', { ...common, sessionKey: await currentKey(), toolName: input.tool_name ?? null, toolUseId: input.tool_use_id ?? null });
} else if (event === 'postToolUse') {
  const key = await currentKey();
  const mode = await store.mode();
  await store.log('tool-end', {
    ...common, sessionKey: key, mode, toolName: input.tool_name ?? null, toolUseId: input.tool_use_id ?? null, durationMs: input.duration ?? null,
  });
  if (key === null || mode !== 'steer') process.exit(0);
  const context = await deliver(key, 'postToolUse', mode);
  if (context) emit({ additional_context: context });
} else if (event === 'stop') {
  const key = await currentKey();
  const mode = await store.mode();
  const loopCount = input.loop_count ?? 0;
  await store.log('hook', { ...common, sessionKey: key, mode, status: input.status ?? null, loopCount });
  // One follow-up per human turn: a follow-up's own stop (loop_count > 0)
  // returns control to the person, and an aborted or failed turn never resumes.
  if (key === null || mode !== 'sync' || input.status !== 'completed' || loopCount > 0) process.exit(0);
  const context = await deliver(key, 'stop', mode);
  if (context) emit({ followup_message: context });
} else if (event === 'beforeMCPExecution') {
  const key = await currentKey();
  await store.log('hook', { ...common, sessionKey: key, toolName: input.tool_name ?? null, serverName: input.mcp_server_name ?? null });
  // No permission decision: Cursor's normal MCP approval setting applies.
  if (key !== null && input.mcp_server_name === 'khala') await recordCaller(store, key);
}
