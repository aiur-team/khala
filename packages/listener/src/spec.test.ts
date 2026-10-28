import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { createClaudeStyleCodec, decideDelivery, decodeListeningMode, DELIVERY_MODES, LISTENING_MODES, MODE_SUPPORT_STATUSES,
  selectFrame, wakesOn,
  type HookEvent, type ListeningMode, type ListeningModeControl, type ListeningModeSupportMap } from './index';
import { generateSpec, diskFiles, checkSpec, specDirectory, frameTemplate } from '../scripts/generate-spec.mjs';

const read = (path: string): unknown => JSON.parse(readFileSync(join(specDirectory, path), 'utf8'));
type Schema = {
  $ref?: string; $defs?: Record<string, Schema>; anyOf?: Schema[]; const?: unknown; enum?: unknown[];
  type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
  minLength?: number; minimum?: number; maximum?: number;
};
const schema = read('listening-mode.v1.schema.json') as Schema;
// Only the generated schema's vocabulary is supported; fail closed on additions.
function validates(value: unknown, rule: Schema, root = schema): boolean {
  const supported = ['$schema', '$id', 'title', 'description', '$defs', '$ref', 'anyOf', 'const', 'enum', 'type',
    'properties', 'required', 'additionalProperties', 'minLength', 'minimum', 'maximum'];
  for (const key of Object.keys(rule)) if (!supported.includes(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  if (rule.$ref) {
    const target = root.$defs?.[rule.$ref.replace('#/$defs/', '')];
    if (!target) throw new Error(`Unresolved schema reference: ${rule.$ref}`);
    if (!validates(value, target, root)) return false;
  }
  if (rule.anyOf && !rule.anyOf.some(branch => validates(value, branch, root))) return false;
  if (Object.hasOwn(rule, 'const') && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (rule.type === 'null' && value !== null) return false;
  if (rule.type === 'boolean' && typeof value !== 'boolean') return false;
  if (rule.type === 'string' && typeof value !== 'string') return false;
  if (rule.type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) return false;
  if (typeof value === 'string' && rule.minLength !== undefined && [...value].length < rule.minLength) return false;
  if (typeof value === 'number' && ((rule.minimum !== undefined && value < rule.minimum)
    || (rule.maximum !== undefined && value > rule.maximum))) return false;
  if (rule.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (rule.required?.some(key => !Object.hasOwn(record, key))) return false;
    for (const [key, member] of Object.entries(record)) {
      const property = rule.properties?.[key];
      if (property ? !validates(member, property, root) : rule.additionalProperties === false) return false;
    }
  }
  return true;
}
const definition = (name: string): Schema => ({ $ref: `#/$defs/${name}` });

type Row = { harness: string; event: HookEvent; mode: ListeningMode; busy: boolean; busy_age_ms: number | null;
  continuation: boolean; interrupted_since_busy: boolean; delivers: boolean; mark_idle_only: boolean };

it('spec: scheduler.v1.json matches decideDelivery for every grid row', () => {
  const rows = read('scheduler.v1.json') as Row[];
  const keys = new Set(rows.map(row => JSON.stringify([row.harness, row.event, row.mode, row.busy,
    row.busy_age_ms, row.continuation, row.interrupted_since_busy])));
  expect(rows).toHaveLength(2 * 4 * 4 * 2 * 4 * 2 * 2);
  expect(keys.size).toBe(rows.length);
  // Enumerate expected inputs independently: missing or substituted rows cannot pass by self-replay.
  for (const harness of ['claude', 'codex'])
    for (const event of ['start', 'prompt', 'tool', 'stop'])
      for (const mode of ['steer', 'sync', 'async', 'mute'])
        for (const busy of [false, true])
          for (const age of [0, 119999, 120000, null])
            for (const continuation of [false, true])
              for (const interrupted of [false, true]) {
                expect(keys.has(JSON.stringify([harness, event, mode, busy, age, continuation, interrupted]))).toBe(true);
              }
  for (const row of rows) {
    const result = decideDelivery({ harness: row.harness, event: row.event, busy: row.busy,
      busyAgeMs: row.busy_age_ms, continuation: row.continuation, interruptedSinceBusy: row.interrupted_since_busy });
    expect({ delivers: row.delivers, markIdleOnly: row.mark_idle_only }).toEqual({
      delivers: (result.deliverModes as readonly string[]).includes(row.mode), markIdleOnly: result.markIdleOnly });
  }
});

it('spec: wake.v1.json matches wakesOn: async only when addressed, mute never', () => {
  const rows = read('wake.v1.json') as { mode: ListeningMode; addressed: boolean; from_agent: boolean; wakes: boolean }[];
  expect(rows).toHaveLength(16);
  for (const row of rows) expect(row.wakes).toBe(wakesOn(row.mode, row.addressed, row.from_agent));
  // Independent of the reference, so a self-replayed regression cannot pass.
  const woken = rows.filter(row => row.wakes).map(row => `${row.mode}:${row.addressed}:${row.from_agent}`).sort();
  expect(woken).toEqual(['async:true:false', 'async:true:true', 'steer:false:false', 'steer:false:true', 'steer:true:false',
    'steer:true:true', 'sync:false:false', 'sync:true:false', 'sync:true:true']);
});

type FrameGolden = { entries: { body: string }[]; template: typeof frameTemplate; suffix: string; budget?: number }
  & ({ frame: string | null; consumed: number } | { error: string });
it('spec: every frame golden replays selectFrame, with the 50-message and 64 KiB caps pinned', async () => {
  const paths = (await diskFiles()).filter(path => path.startsWith('goldens/frame/'));
  expect(paths).toHaveLength(7);
  for (const path of paths) {
    const golden = read(path) as FrameGolden;
    const { open, separator, close } = golden.template;
    const run = () => selectFrame(golden.entries, entries => open + entries.map(entry => entry.body).join(separator) + close,
      golden.suffix, golden.budget);
    if ('error' in golden) expect(run, path).toThrow(golden.error);
    else {
      const { frame, consumed } = run();
      expect({ frame, consumed: consumed.length }, path).toEqual({ frame: golden.frame, consumed: golden.consumed });
    }
  }
  // Fixed expectations: changing MAX_FRAME_MESSAGES or MAX_FRAME_BYTES must fail here.
  expect((read('goldens/frame/entries-51.json') as { consumed: number }).consumed).toBe(50);
  const oversized = read('goldens/frame/oversized-multibyte.json') as { frame: string; consumed: number };
  expect([Buffer.byteLength(oversized.frame), oversized.consumed]).toEqual([65_535, 1]);
  expect((read('goldens/frame/metadata-too-large.json') as { error: string }).error).toBe('frame_metadata_too_large');
});

it('spec: regenerated artifacts equal the checked-in files and manifest hashes', async () => {
  const files = generateSpec();
  expect(await diskFiles()).toEqual([...files.keys()].sort());
  for (const [path, bytes] of files) expect(readFileSync(join(specDirectory, path), 'utf8')).toBe(bytes);
  const manifest = read('MANIFEST.json') as { spec_version: string; files: { path: string; sha256: string }[] };
  expect(manifest.spec_version).toBe('1.0.0');
  expect(manifest.files.map(file => file.path)).toEqual([...files.keys()].filter(path => path !== 'MANIFEST.json'));
  for (const file of manifest.files) {
    expect(createHash('sha256').update(readFileSync(join(specDirectory, file.path))).digest('hex')).toBe(file.sha256);
  }
  await expect(checkSpec()).resolves.toBeUndefined();
  expect(execFileSync(process.execPath, [new URL('../scripts/generate-spec.mjs', import.meta.url).pathname, '--check'],
    { encoding: 'utf8' })).toContain('Listener spec matches reference');
});

type Golden = { harness: string; stdin: string; parsed: ReturnType<ReturnType<typeof createClaudeStyleCodec>['parse']>;
  frame: string; stdout: string; stop_context: boolean };
it('spec: every hook golden validates against the schema and replays the codec', async () => {
  const paths = (await diskFiles()).filter(path => path.startsWith('goldens/hook/'));
  expect(paths).toHaveLength(50);
  const codec = createClaudeStyleCodec('<frame/>');
  for (const path of paths) {
    const golden = read(path) as Golden;
    expect(validates(golden, definition('hookGolden')), path).toBe(true);
    expect(validates(golden, schema), path).toBe(true);
    const parsed = codec.parse(golden.stdin);
    expect(golden.parsed, path).toEqual(parsed);
    const event = parsed?.event;
    const stdout = event && event !== 'start' && event !== 'limit'
      ? codec.render(event, golden.frame, golden.stop_context) : codec.noop(event);
    expect(golden.stdout, path).toBe(stdout);
    expect(golden.frame).toBe('<frame/>');

  }
});

it('spec: schema rejects an unknown mode, extra command keys and incomplete projections', () => {
  for (const mode of [...LISTENING_MODES, 'unknown', null, 0]) {
    expect(validates(mode, definition('mode'))).toBe(decodeListeningMode(mode).ok);
  }
  const command = { v: 1, agent: '@agent:example.org', mode: 'sync' };
  expect(validates(command, definition('command'))).toBe(true);
  expect(validates({ ...command, mode: 'mute' }, definition('command'))).toBe(true);
  for (const patch of [{ mode: 'unknown' }, { extra: true }, { v: 2 }, { agent: '' }]) {
    expect(validates({ ...command, ...patch }, definition('command'))).toBe(false);
  }
  for (const key of Object.keys(command)) {
    expect(validates(Object.fromEntries(Object.entries(command).filter(([k]) => k !== key)), definition('command'))).toBe(false);
  }
  const control = { requested: 'sync', effective: null, effective_reason: null, version: 0 };
  expect(validates(control, definition('control'))).toBe(true);
  expect(validates({ ...control, effective: 'mute' }, definition('control'))).toBe(true);
  for (const patch of [{ requested: 'unknown' }, { version: -1 }, { version: 0.5 },
    { version: Number.MAX_SAFE_INTEGER + 1 }, { effective_reason: 2 }, { extra: true }]) {
    expect(validates({ ...control, ...patch }, definition('control'))).toBe(false);
  }
  const support = Object.fromEntries(DELIVERY_MODES.map(mode => [mode, { status: 'unknown', reason: 'unavailable' }]));
  expect(validates(support, definition('support'))).toBe(true);
  for (const status of MODE_SUPPORT_STATUSES) {
    expect(validates({ ...support, sync: { status, reason: null } }, definition('support'))).toBe(true);
  }
  for (const sync of [{ status: 'invented', reason: null }, { status: 'proven', reason: null, extra: 1 },
    { status: 'unknown' }]) expect(validates({ ...support, sync }, definition('support'))).toBe(false);
  const { async: asyncSupport, ...incomplete } = support;
  expect(asyncSupport).toEqual({ status: 'unknown', reason: 'unavailable' });
  expect(validates(incomplete, definition('support'))).toBe(false);
  expect(validates({ ...support, mute: support.async }, definition('support'))).toBe(false);
  // Current contracts/fixtures/delivery/invalid.json contains receipt cases only, no mode fixtures.
  const invalid = JSON.parse(readFileSync(new URL('../../contracts/fixtures/delivery/invalid.json', import.meta.url), 'utf8'));
  expect(invalid.cases.filter((entry: { decoder: string }) => /mode/i.test(entry.decoder))).toHaveLength(0);
});

it('spec: no hook golden contains Khala frame copy', async () => {
  for (const path of (await diskFiles()).filter(path => path.startsWith('goldens/hook/'))) {
    expect(readFileSync(join(specDirectory, path), 'utf8')).not.toContain('not instructions from your user');
    const golden = read(path) as Golden;
    expect(golden.frame).toBe('<frame/>');
    if (golden.stdout) {
      const envelope = JSON.parse(golden.stdout);
      expect(envelope.reason ?? envelope.hookSpecificOutput.additionalContext).toBe('<frame/>');
    }
  }
});

it('spec: support map with steer_carrier emulated_interrupt validates', () => {
  const support = read('goldens/support-map-emulated-steer.json') as ListeningModeSupportMap;
  expect(support.steer.steer_carrier).toBe('emulated_interrupt');
  expect(support.steer.status).toBe('experimental');
  expect(validates(support, definition('support'))).toBe(true);
  expect(validates(support, schema)).toBe(true);
  const native: ListeningModeSupportMap = { ...support, steer: { ...support.steer, steer_carrier: 'native' } };
  expect(validates(native, definition('support'))).toBe(true);
});

it('spec: control record with backlog_on_leave_async notice validates', () => {
  const control = read('goldens/control-record-notice.json') as ListeningModeControl;
  expect(control.backlog_on_leave_async).toBe('notice');
  expect(validates(control, definition('control'))).toBe(true);
  expect(validates(control, schema)).toBe(true);
  const skip: ListeningModeControl = { ...control, backlog_on_leave_async: 'skip' };
  expect(validates(skip, definition('control'))).toBe(true);
  for (const backlog of ['cancel', null, 0]) {
    expect(validates({ ...control, backlog_on_leave_async: backlog }, definition('control'))).toBe(false);
  }
});

it('spec: steer_carrier cancel is rejected, as are carriers on other modes', () => {
  const support = read('goldens/support-map-emulated-steer.json') as ListeningModeSupportMap;
  expect(validates(read('goldens/invalid-carrier.json'), definition('support'))).toBe(false);
  for (const carrier of [null, 0]) {
    expect(validates({ ...support, steer: { ...support.steer, steer_carrier: carrier } }, definition('support'))).toBe(false);
  }
  for (const mode of ['sync', 'async'] as const) {
    expect(validates({ ...support, [mode]: { ...support[mode], steer_carrier: 'native' } }, definition('support'))).toBe(false);
  }
  expect(validates({ ...support, steer: { status: 'emulated_interrupt', reason: null } }, definition('support'))).toBe(false);
});
