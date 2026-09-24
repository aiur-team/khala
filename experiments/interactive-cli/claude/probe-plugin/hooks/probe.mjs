import { appendFile, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

const runDir = process.env.KHALA_PROOF_RUN_DIR;
const mode = process.env.KHALA_PROOF_MODE;
if (!runDir || !['steer', 'sync', 'rewake'].includes(mode)) process.exit(0);

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const input = JSON.parse(stdin);
const sessionId = input.session_id;
const event = input.hook_event_name;
if (typeof sessionId !== 'string' || typeof event !== 'string') process.exit(0);

await mkdir(join(runDir, 'pending'), { recursive: true });
await mkdir(join(runDir, 'delivered'), { recursive: true });

async function log(kind, fields = {}) {
  await appendFile(join(runDir, 'events.jsonl'), `${JSON.stringify({
    at: new Date().toISOString(),
    kind,
    mode,
    event,
    sessionId,
    promptId: input.prompt_id ?? null,
    stopHookActive: input.stop_hook_active ?? null,
    toolName: input.tool_name ?? null,
    ...fields,
  })}\n`, { mode: 0o600 });
}

async function claim() {
  const prefix = `${sessionId}.${mode}.`;
  const candidates = (await readdir(join(runDir, 'pending')))
    .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
    .sort();
  for (const name of candidates) {
    const source = join(runDir, 'pending', name);
    const claimed = `${source}.${process.pid}.claimed`;
    try {
      await rename(source, claimed);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const item = JSON.parse(await readFile(claimed, 'utf8'));
    const delivered = join(runDir, 'delivered', basename(name));
    await rename(claimed, delivered);
    await log('claimed', {
      batchToken: item.batchToken,
      bytes: Buffer.byteLength(item.message),
      sha256: createHash('sha256').update(item.message).digest('hex'),
    });
    return item;
  }
  return null;
}

await log('hook');

if (mode === 'steer' && event === 'PostToolUse') {
  const item = await claim();
  if (item) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[khala:${item.batchToken}] ${item.message}`,
      },
    }));
  }
  process.exit(0);
}

if (mode === 'sync' && event === 'Stop') {
  if (input.stop_hook_active === true) process.exit(0);
  const item = await claim();
  if (item) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `[khala:${item.batchToken}] ${item.message}`,
    }));
  }
  process.exit(0);
}

if (mode === 'rewake' && event === 'UserPromptSubmit') {
  const wakeDir = join(runDir, 'wake');
  const wakePath = join(wakeDir, `${sessionId}.ready`);
  await mkdir(wakeDir, { recursive: true });
  try {
    await unlink(wakePath);
    const item = await claim();
    if (item) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `[khala:${item.batchToken}] ${item.message}`,
        },
      }));
    }
    process.exit(0);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const prefix = `${sessionId}.${mode}.`;
    const pending = (await readdir(join(runDir, 'pending')))
      .some(name => name.startsWith(prefix) && name.endsWith('.json'));
    if (pending) {
      const handle = await open(wakePath, 'wx', 0o600);
      await handle.close();
      process.stderr.write('Khala channel update available');
      process.exit(2);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
