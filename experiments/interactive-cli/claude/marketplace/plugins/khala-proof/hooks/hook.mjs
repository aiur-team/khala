import { randomBytes } from 'node:crypto';
import { readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { WAKE_MARKER, frame, openStore, stateDirFrom } from '../lib/store.mjs';

const role = process.argv[2] ?? 'main';
const dir = stateDirFrom(process.env);
if (!dir) process.exit(0);
const store = await openStore(dir);
if (!store) process.exit(0);

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const input = JSON.parse(stdin);
const sessionId = input.session_id;
const event = input.hook_event_name;
if (typeof sessionId !== 'string' || typeof event !== 'string') process.exit(0);

const common = {
  sessionId,
  event,
  role,
  promptId: input.prompt_id ?? null,
  claudePid: await findClaudePid(),
};

function emit(value) {
  process.stdout.write(JSON.stringify(value));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The hook may run under an intermediate shell; find the Claude process itself.
async function findClaudePid() {
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth += 1) {
    const exe = await readlink(`/proc/${pid}/exe`).catch(() => '');
    if (exe.includes('claude')) return pid;
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  }
  return process.ppid;
}

function parentAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Only stop-long wakes leave this marker for main(); prompt40 keeps its own
// (committed) claim path so its behavior can be observed unchanged.
async function consumeWake() {
  if ((await store.watch()).variant !== 'stop-long') return false;
  try {
    await rm(store.path('watcher', `${sessionId}.woke`));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function main() {
  if (event === 'SessionStart') {
    await store.log('hook', { ...common, source: input.source ?? null });
    await store.bind(sessionId, input.source ?? null);
    await store.setActivity(sessionId, 'idle', 'SessionStart');
    return;
  }
  if (event === 'UserPromptSubmit') {
    await store.log('hook', common);
    await store.setActivity(sessionId, 'busy', 'UserPromptSubmit');
    // A stop-long wake: claim here, in a synchronous hook whose output
    // reaches the model, never in the backgrounded watcher.
    if (await consumeWake()) {
      const { releases } = await store.pull(sessionId, 'UserPromptSubmit-wake');
      if (releases.length === 0) return;
      await store.log('delivered', { ...common, boundary: 'UserPromptSubmit-wake', releaseIds: releases.map(item => item.releaseId) });
      emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: frame(releases) } });
    }
    return;
  }
  if (event === 'PreToolUse') {
    await store.log('tool-start', { ...common, toolName: input.tool_name, toolUseId: input.tool_use_id ?? null });
    return;
  }
  const mode = await store.mode();
  if (event === 'PostToolUse') {
    await store.log('tool-end', { ...common, mode, toolName: input.tool_name, toolUseId: input.tool_use_id ?? null });
    if (mode !== 'steer') return;
    const { releases } = await store.pull(sessionId, 'PostToolUse');
    if (releases.length === 0) return;
    await store.log('delivered', { ...common, mode, boundary: 'PostToolUse', releaseIds: releases.map(item => item.releaseId) });
    emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: frame(releases) } });
    return;
  }
  if (event === 'Stop') {
    await store.log('hook', { ...common, mode, stopHookActive: input.stop_hook_active ?? null });
    const woke = input.stop_hook_active === true && mode !== 'async' && (await consumeWake());
    if ((input.stop_hook_active === true && !woke) || mode === 'async') {
      await store.setActivity(sessionId, 'idle', 'Stop');
      return;
    }
    const { releases } = await store.pull(sessionId, woke ? 'Stop-wake' : 'Stop');
    if (releases.length === 0) {
      await store.setActivity(sessionId, 'idle', 'Stop');
      return;
    }
    await store.log('delivered', { ...common, mode, boundary: woke ? 'Stop-wake' : 'Stop', releaseIds: releases.map(item => item.releaseId) });
    emit({ decision: 'block', reason: frame(releases) });
  }
}

// The design committed before this rework: a 40-second UserPromptSubmit
// watcher emits a content-free marker, and the next invocation of the same
// (asyncRewake) hook claims the batch as additionalContext.
async function watchPrompt() {
  const watch = await store.watch();
  if (watch.variant !== 'prompt40' || event !== 'UserPromptSubmit') return;
  const woke = store.path('watcher', `${sessionId}.woke`);
  try {
    await readFile(woke);
    await rm(woke, { force: true });
    const { releases } = await store.pull(sessionId, 'UserPromptSubmit-rewake');
    await store.log('rewake-claim', { ...common, releaseIds: releases.map(item => item.releaseId) });
    if (releases.length > 0) {
      emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: frame(releases) } });
    }
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const seconds = watch.deadlineSeconds ?? 40;
  await store.log('watch-armed', { ...common, variant: watch.variant, deadlineSeconds: seconds });
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if ((await store.inboxNames()).length > 0) {
      await writeFile(woke, '', { mode: 0o600 });
      await store.log('wake', { ...common, variant: watch.variant });
      process.stderr.write(WAKE_MARKER);
      process.exit(2);
    }
    await sleep(100);
  }
  await store.log('watch-expired', { ...common, variant: watch.variant, deadlineSeconds: seconds });
}

// Rework route: arm at every Stop (the moment the session goes idle), wake only
// while idle, keep one watcher per session, and exit with the Claude process.
async function watchStop() {
  const watch = await store.watch();
  if (watch.variant !== 'stop-long' || event !== 'Stop') return;
  const owner = store.path('watcher', `${sessionId}.owner`);
  const nonce = randomBytes(6).toString('hex');
  await writeFile(owner, nonce, { mode: 0o600 });
  const seconds = watch.deadlineSeconds ?? 3000;
  const { claudePid } = common;
  await store.log('watch-armed', { ...common, variant: watch.variant, deadlineSeconds: seconds, watcher: nonce });
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if ((await readFile(owner, 'utf8').catch(() => '')) !== nonce) {
      await store.log('watch-superseded', { ...common, watcher: nonce });
      return;
    }
    if (!parentAlive(claudePid)) {
      await store.log('watch-orphan-exit', { ...common, watcher: nonce });
      return;
    }
    const activity = await store.activity();
    if (activity?.sessionId === sessionId && activity.state === 'idle' && (await store.inboxNames()).length > 0) {
      await store.setActivity(sessionId, 'busy', 'wake');
      await writeFile(store.path('watcher', `${sessionId}.woke`), '', { mode: 0o600 });
      await store.log('wake', { ...common, variant: watch.variant, watcher: nonce, idleSince: activity.at });
      process.stderr.write(WAKE_MARKER);
      process.exit(2);
    }
    await sleep(250);
  }
  await store.log('watch-expired', { ...common, variant: watch.variant, deadlineSeconds: seconds, watcher: nonce });
}

if (role === 'main') await main();
else if (role === 'watch-prompt') await watchPrompt();
else if (role === 'watch-stop') await watchStop();
