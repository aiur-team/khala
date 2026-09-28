import assert from 'node:assert/strict';
import test from 'node:test';
import { distinctAuthenticatedOwners, distinctNativeAgents } from './four-actor-config';
import type { NativeReviewConfig } from './native-witness';

test('four-actor proof requires two distinct authenticated owner IDs', () => {
  const first = { status: 200, ownerId: 'owner_one' };
  const second = { status: 200, ownerId: 'owner_two' };
  assert.equal(distinctAuthenticatedOwners(first, second), true);
  assert.equal(distinctAuthenticatedOwners(first, { status: 200, ownerId: first.ownerId }), false);
  assert.equal(distinctAuthenticatedOwners(first, { status: 200, ownerId: null }), false);
  assert.equal(distinctAuthenticatedOwners({ status: 401, ownerId: first.ownerId }, second), false);
  assert.equal(distinctAuthenticatedOwners(first, { status: 503, ownerId: second.ownerId }), false);
});

const first: NativeReviewConfig = {
  pid: 1001, startTicks: '123', executable: '/bin/codex', workdir: '/private/first',
  cgroup: '/first', codexHome: '/private/first/codex', xdgStateHome: '/private/first/state',
  xdgDataHome: '/private/first/data', rolloutFile: '/private/first/codex/sessions/rollout.jsonl',
};
const second: NativeReviewConfig = {
  ...first, pid: 1002, codexHome: '/private/second/codex',
  xdgStateHome: '/private/second/state', xdgDataHome: '/private/second/data',
  rolloutFile: '/private/second/codex/sessions/rollout.jsonl',
};
const firstProcess = { pid: 2001, sessionId: 'session-first' };
const secondProcess = { pid: 2002, sessionId: 'session-second' };

test('four-actor descriptor needs two independent native agents and private homes', () => {
  assert.equal(distinctNativeAgents(first, second, firstProcess, secondProcess), true);
  assert.equal(distinctNativeAgents(first, first, firstProcess, secondProcess), false);
  assert.equal(distinctNativeAgents(first, second, firstProcess, firstProcess), false);
  assert.equal(distinctNativeAgents(first, second, firstProcess,
    { ...secondProcess, sessionId: firstProcess.sessionId }), false);
  assert.equal(distinctNativeAgents(first,
    { ...second, xdgStateHome: first.xdgStateHome }, firstProcess, secondProcess), false);
});
