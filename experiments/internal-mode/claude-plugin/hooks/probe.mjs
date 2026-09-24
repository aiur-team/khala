import { appendFile, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const runDir = process.env.KHALA_HOOK_PROBE_DIR;
if (!runDir) process.exit(0);

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const input = JSON.parse(stdin);
const sessionId = input.session_id;
const event = input.hook_event_name;
if (typeof sessionId !== 'string' || typeof event !== 'string') process.exit(0);

await mkdir(join(runDir, 'pending'), { recursive: true });
await appendFile(join(runDir, 'events.jsonl'), `${JSON.stringify({
  at: new Date().toISOString(),
  event,
  sessionId,
  cwd: input.cwd,
  promptId: input.prompt_id ?? null,
  stopHookActive: input.stop_hook_active ?? null,
  toolName: input.tool_name ?? null,
})}\n`);

async function drain(channel) {
  const pending = join(runDir, 'pending', `${sessionId}.${channel}.json`);
  const claimed = join(runDir, 'pending', `${sessionId}.${channel}.${process.pid}.claimed`);
  try {
    await rename(pending, claimed);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(await readFile(claimed, 'utf8'));
  } finally {
    await unlink(claimed).catch(() => {});
  }
}

function reminder(message, source) {
  return `[khala-probe:${source}] ${message}`;
}

if (event === 'PostToolUse') {
  const item = await drain('post-tool');
  if (item) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: reminder(item.message, 'post-tool'),
      },
    }));
  }
  process.exit(0);
}

if (event === 'Stop') {
  const item = await drain('stop');
  if (item) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: reminder(item.message, 'stop'),
      },
    }));
  }
  process.exit(0);
}

if (event === 'UserPromptSubmit') {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const item = await drain('rewake');
    if (item) {
      process.stderr.write(reminder(item.message, 'rewake'));
      process.exit(2);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
