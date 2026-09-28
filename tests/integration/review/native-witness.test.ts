import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspectInboxSelection, inspectSelectedOnlyInterval, reviewRolloutIdentity,
  selectedOnlyWitnessMatches } from './native-witness';

const launcher = '/private/data/khala/bin/khala';
const token = 'boundedToken12345';
const rows = [
  { type: 'response_item', payload: { type: 'message', role: 'developer',
    content: `batchToken: ${token}\nreleased B` } },
  { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_1',
    input: `const result = await tools.exec_command({cmd:"${launcher} read --ack ${token}"});text(result.output)` } },
  { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_1',
    output: 'Process exited with code 0\n{"ok":true,"kind":"empty"}' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'I read released B' } },
] as const;
const inspect = (records: readonly { type?: unknown; payload?: unknown }[]) => inspectSelectedOnlyInterval({
  records, withheld: 'pending A', released: 'released B', launcher, workdir: '/private/work',
});

test('current native identity rejects another session or last-turn model switch', () => {
  const base = [
    { type: 'session_meta', payload: { id: 'session-1', cwd: '/private/work', cli_version: '0.157.1' } },
    { type: 'turn_context', payload: { model: 'gpt-6-sol', cwd: '/private/work' } },
  ];
  assert.equal(reviewRolloutIdentity(base, 'session-1', '/private/work'), true);
  assert.equal(reviewRolloutIdentity(base, 'session-2', '/private/work'), false);
  assert.equal(reviewRolloutIdentity([...base, { type: 'turn_context', payload: {
    model: 'gpt-6-astra', cwd: '/private/work' } }], 'session-1', '/private/work'), false);
});

test('a non-Sol or wrong-workdir turn inside the scenario fails even after switching back', () => {
  const sol = { type: 'turn_context', payload: { model: 'gpt-6-sol', cwd: '/private/work' } };
  assert.throws(() => inspect([sol, { type: 'turn_context', payload: {
    model: 'gpt-6-astra', cwd: '/private/work' } }, sol, ...rows]), /interval_identity_mismatch/u);
  assert.throws(() => inspect([{ type: 'turn_context', payload: {
    model: 'gpt-6-sol', cwd: '/foreign/work' } }, ...rows]), /interval_identity_mismatch/u);
});

test('same-interval hook body, model call/output and relay establish the selected B', () => {
  assert.deepEqual(inspect(rows), { visible: true, relayed: true, withheldAbsent: true,
    ackDigest: 'd3fc6fe6aca6140edac3a061ae1689c409d2f4e31db8e357ee95fc5708bd33ef' });
});

test('a real pending A leaking through any native response item fails', () => {
  assert.equal(inspect([...rows, { type: 'response_item', payload: {
    type: 'message', role: 'user', content: 'pending A' } }]).withheldAbsent, false);
});

test('a command without its matching successful native tool output is not an ACK', () => {
  assert.equal(inspect(rows.filter(row => row.payload.type !== 'custom_tool_call_output')).ackDigest, null);
  assert.equal(inspect(rows.map(row => row.payload.type === 'custom_tool_call_output'
    ? { ...row, payload: { ...row.payload, output: 'Process exited with code 1' } } : row)).ackDigest, null);
});

test('a historical B outside the selected interval cannot satisfy visibility or relay', () => {
  assert.deepEqual(inspect(rows.slice(1)), { visible: false, relayed: true, withheldAbsent: true, ackDigest: null });
});

test('an unrelated token or call output does not attest the release', () => {
  assert.equal(inspect(rows.map(row => row.payload.type === 'custom_tool_call_output'
    ? { ...row, payload: { ...row.payload, call_id: 'other_call' } } : row)).ackDigest, null);
  assert.equal(inspect(rows.map(row => row.payload.type === 'custom_tool_call'
    ? { ...row, payload: { ...row.payload,
      input: `const result = await tools.exec_command({cmd:"${launcher} read --ack otherToken123"});text(result.output)` } } : row)).ackDigest, null);
});

test('quoted instructions and shell echo are not executable ACK commands', () => {
  const mutate = (input: string) => inspect(rows.map(row => row.payload.type === 'custom_tool_call'
    ? { ...row, payload: { ...row.payload, input } } : row)).ackDigest;
  assert.equal(mutate(`text("${launcher} read --ack ${token}")`), null);
  assert.equal(mutate(`const result = await tools.exec_command({cmd:"echo '${launcher} read --ack ${token}'"});text(result.output)`), null);
});

const payload = Buffer.from('{"body":"released B"}', 'utf8');
const record = { v: 1, releaseId: 'release_B', bindingId: 'binding_owner', generation: 3,
  events: [{ eventId: 'event_B' }], payloadBase64: payload.toString('base64'),
  payloadDigest: `sha256:${createHash('sha256').update(payload).digest('hex')}` };
const selected = { releaseId: 'release_B', bindingId: 'binding_owner', generation: 3,
  releasedEventId: 'event_B', withheldEventId: 'event_A', released: 'released B' };

test('durable inbox release is exact B and rejects an enqueued pending A', () => {
  assert.equal(inspectInboxSelection([record], selected), true);
  assert.equal(inspectInboxSelection([record, { ...record, releaseId: 'release_A',
    events: [{ eventId: 'event_A' }] }], selected), false);
  assert.equal(inspectInboxSelection([{ ...record, events: [{ eventId: 'event_A' }] }], selected), false);
  assert.equal(inspectInboxSelection([{ ...record, payloadDigest: `sha256:${'0'.repeat(64)}` }], selected), false);
  assert.equal(inspectInboxSelection([record, record], selected), false);
  assert.equal(inspectInboxSelection([record], { ...selected, releaseId: 'wrong_release' }), false);
  assert.equal(inspectInboxSelection([record], { ...selected, generation: 4 }), false);
});

test('final witness requires the exact advanced cursor and complete model evidence', () => {
  const observed = inspect(rows);
  const cursor = { v: 1, offset: 256, releaseId: selected.releaseId };
  assert.equal(selectedOnlyWitnessMatches(cursor, selected.releaseId, observed), true);
  assert.equal(selectedOnlyWitnessMatches(null, selected.releaseId, observed), false);
  assert.equal(selectedOnlyWitnessMatches({ ...cursor, releaseId: 'older_release' }, selected.releaseId, observed), false);
  assert.equal(selectedOnlyWitnessMatches({ ...cursor, releaseId: 'wrong_release' }, selected.releaseId, observed), false);
  assert.equal(selectedOnlyWitnessMatches({ v: 1, offset: 256 }, selected.releaseId, observed), false);
  assert.equal(selectedOnlyWitnessMatches({ ...cursor, offset: 0 }, selected.releaseId, observed), false);
  assert.equal(selectedOnlyWitnessMatches(cursor, selected.releaseId, { ...observed, ackDigest: null }), false);
  assert.equal(selectedOnlyWitnessMatches(cursor, selected.releaseId, { ...observed, visible: false }), false);
  assert.equal(selectedOnlyWitnessMatches(cursor, selected.releaseId, { ...observed, withheldAbsent: false }), false);
});
