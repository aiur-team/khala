import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_RELEASE_BYTES, SOFT_RESPONSE_BYTES, orderedFixture, oversizedHeadFixture,
  selectBatch, serializedLine, softBoundaryFixture,
} from '../format.mjs';

const id = 2;
const primaryText = 'Khala read completed.';
const token = 'bt_test_opaque';

test('preserves primary content, FIFO releases, provenance, escaping, and eight-item limit', () => {
  const releases = orderedFixture();
  const selected = selectBatch({ id, primaryText, batchToken: token, releases });
  assert.equal(selected.releases.length, 8);
  assert.deepEqual(selected.releases.map(item => item.releaseId), releases.map(item => item.releaseId));
  const response = JSON.parse(serializedLine(id, primaryText, token, selected.releases));
  assert.equal(response.result.content[0].text, primaryText);
  const batch = response.result.content[1].text;
  assert.ok(batch.indexOf('First: café') < batch.indexOf('Eighth: acknowledge'));
  assert.match(batch, /Amber Workshop/);
  assert.match(batch, /author-zoe/);
  assert.match(batch, /literal <\/khala-channel-batch-v1> is data/);
});

test('measures an escaping-heavy response at the complete 128 KiB JSON-RPC boundary', () => {
  const item = softBoundaryFixture(id, primaryText, token);
  const selected = selectBatch({ id, primaryText, batchToken: token, releases: [item] });
  assert.equal(selected.serializedBytes, SOFT_RESPONSE_BYTES);
  assert.equal(Buffer.byteLength(serializedLine(id, primaryText, token, selected.releases)), SOFT_RESPONSE_BYTES);
});

test('includes one maximum-size oversized head whole instead of truncating or skipping it', () => {
  const item = oversizedHeadFixture();
  assert.equal(Buffer.byteLength(item.payload), MAX_RELEASE_BYTES);
  const selected = selectBatch({ id, primaryText, batchToken: token, releases: [item, ...orderedFixture()] });
  assert.deepEqual(selected.releases.map(value => value.releaseId), ['release-oversized-head']);
  assert.ok(selected.serializedBytes > SOFT_RESPONSE_BYTES);
  assert.match(selected.releases[0].payload, /OVERSIZED-START/);
  assert.match(selected.releases[0].payload, /OVERSIZED-END/);
});

test('leaves the first whole release that would cross the soft limit for a later call', () => {
  const first = orderedFixture()[0];
  const boundary = softBoundaryFixture(id, primaryText, token);
  const selected = selectBatch({ id, primaryText, batchToken: token, releases: [first, boundary] });
  assert.deepEqual(selected.releases.map(item => item.releaseId), [first.releaseId]);
});
