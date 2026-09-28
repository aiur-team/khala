import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { inspectNativeSolRollout } from './native-sol-rollout';

const launcher = '/private/data/khala/bin/khala';
const token = 'exact-batch-token-12345';
const digest = createHash('sha256').update(token).digest('hex');
const context = { type: 'response_item', payload: { type: 'message', role: 'developer',
  content: `synthetic released release-abc; batchToken ${token}` } };
const relay = { type: 'response_item', payload: { type: 'message', role: 'assistant',
  content: 'synthetic released release-abc' } };
const call = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec',
  input: `const result = await tools.exec_command({cmd:"${launcher} read --ack ${token}"});` } };

describe('native Sol rollout proof', () => {
  it('requires native model context, relay, and an exact model-originated ACK call', () => {
    const proof = inspectNativeSolRollout([context, relay, call], 'release-abc', 'unsubmitted-xyz', launcher);
    assert.equal(proof.visibleRelease, true);
    assert.equal(proof.agentRelay, true);
    assert.equal(proof.unsubmittedAbsent, true);
    assert.equal(proof.modelAckDigests.has(digest), true);
  });
  it('does not accept a user prompt, foreign launcher, or plain assistant claim as an ACK call', () => {
    const proof = inspectNativeSolRollout([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'read --ack fake-token' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: `I called read --ack ${token}` } },
      { ...call, payload: { ...call.payload, input: call.payload.input.replace(launcher, '/foreign/khala') } },
    ], 'release-abc', 'unsubmitted-xyz', launcher);
    assert.equal(proof.visibleRelease, false);
    assert.equal(proof.agentRelay, false);
    assert.equal(proof.modelAckDigests.size, 0);
  });
  it('detects any leaked unsubmitted marker in rollout content', () => {
    const proof = inspectNativeSolRollout([context, relay, call,
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'unsubmitted-xyz' } },
    ], 'release-abc', 'unsubmitted-xyz', launcher);
    assert.equal(proof.unsubmittedAbsent, false);
  });
});
