import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { listeningSchema } from './schema.mjs';

const { LISTENING_MODES, MODE_SUPPORT_STATUSES, decideDelivery, createClaudeStyleCodec } =
  await tsImport('../src/index.ts', import.meta.url);
export const specDirectory = fileURLToPath(new URL('../spec/v1/', import.meta.url));
const eventNames = { start: 'SessionStart', prompt: 'UserPromptSubmit', tool: 'PostToolUse', stop: 'Stop' };

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  }
  return value;
}
export const serialize = value => JSON.stringify(sortKeys(value), null, 2) + '\n';
const sha256 = body => createHash('sha256').update(body).digest('hex');

/** Returns bytes without writing, so tests and --check exercise the same generator. */
export function generateSpec() {
  const files = new Map();
  files.set('listening-mode.v1.schema.json', serialize(listeningSchema(LISTENING_MODES, MODE_SUPPORT_STATUSES)));
  const rows = [];
  for (const harness of ['claude', 'codex'])
    for (const event of Object.keys(eventNames))
      for (const mode of LISTENING_MODES)
        for (const busy of [false, true])
          for (const busy_age_ms of [0, 119999, 120000, null])
            for (const continuation of [false, true])
              for (const interrupted_since_busy of [false, true]) {
                const decision = decideDelivery({ harness, event, busy, busyAgeMs: busy_age_ms,
                  continuation, interruptedSinceBusy: interrupted_since_busy });
                rows.push({ harness, event, mode, busy, busy_age_ms, continuation, interrupted_since_busy,
                  delivers: decision.deliverModes.includes(mode), mark_idle_only: decision.markIdleOnly });
              }
  files.set('scheduler.v1.json', serialize(rows));
  // Pass neutral product copy for both Stop's block reason and context envelopes.
  const frame = '<frame/>';
  const codec = createClaudeStyleCodec(frame);
  for (const harness of ['claude', 'codex']) {
    for (const [event, hook_event_name] of Object.entries(eventNames)) {
      const base = { session_id: 'session-1', hook_event_name, cwd: '/workspace',
        transcript_path: '/workspace/transcript.jsonl', ...(event === 'prompt' ? { prompt: 'hello' } : {}) };
      const cases = [
        ['absent', JSON.stringify(base), false],
        ['false', JSON.stringify({ ...base, stop_hook_active: false }), false],
        ['true', JSON.stringify({ ...base, stop_hook_active: true }), false],
        ['invalid-boolean', JSON.stringify({ ...base, stop_hook_active: 'false' }), false],
        ['invalid-json', '{', false],
        ['missing-session', JSON.stringify({ hook_event_name }), false],
        ...(event === 'stop' ? [['context', JSON.stringify(base), true]] : []),
      ];
      for (const [name, stdin, stop_context] of cases) {
        const parsed = codec.parse(stdin);
        const stdout = parsed && event !== 'start' ? codec.render(event, frame, stop_context) : codec.noop(event);
        files.set(`goldens/hook/${harness}-${hook_event_name}-${name}.json`,
          serialize({ harness, stdin, parsed, frame, stdout, stop_context }));
      }
    }
  }
  const sorted = new Map([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  sorted.set('MANIFEST.json', serialize({ spec_version: '1.0.0',
    files: [...sorted].map(([path, body]) => ({ path, sha256: sha256(body) })) }));
  return sorted;
}

export async function diskFiles(directory = specDirectory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => entry.isDirectory()
    ? diskFiles(join(directory, entry.name), prefix + entry.name + '/') : [prefix + entry.name]));
  return files.flat().sort();
}

export async function checkSpec() {
  const generated = generateSpec();
  const actual = await diskFiles().catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const changed = [];
  for (const path of new Set([...generated.keys(), ...actual])) {
    const body = await readFile(join(specDirectory, path), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!generated.has(path) || generated.get(path) !== body) changed.push(path);
  }
  if (changed.length) throw new Error(`Listener spec drift: ${changed.join(', ')}. Run node packages/listener/scripts/generate-spec.mjs`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: generate-spec.mjs [--check]');
  if (process.argv.includes('--check')) {
    await checkSpec();
    console.log('Listener spec matches reference');
  } else {
    const files = generateSpec();
    for (const [path, body] of files) {
      const target = join(specDirectory, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
    }
    console.log(`Generated ${files.size} listener artifacts in ${relative(process.cwd(), specDirectory)}`);
  }
}
