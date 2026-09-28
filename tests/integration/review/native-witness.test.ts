import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspectInboxSelection, inspectSelectedOnlyInterval } from './native-witness';

const launcher = '/private/data/khala/bin/khala';
const token = 'boundedToken12345';
const rows = [
  { type: 'response_item', payload: { type: 'message', role: 'developer',
    content: `batchToken: ${token}\nreleased B` } },
  { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_1',
    input: `${launcher} read --ack ${token}` } },
  { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_1',
    output: 'Process exited with code 0\n{"ok":true,"kind":"empty"}' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'I read released B' } },
] as const;
const inspect = (records: readonly { type?: unknown; payload?: unknown }[]) => inspectSelectedOnlyInterval({
  records, withheld: 'pending A', released: 'released B', launcher,
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
    ? { ...row, payload: { ...row.payload, input: `${launcher} read --ack otherToken123` } } : row)).ackDigest, null);
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
});
