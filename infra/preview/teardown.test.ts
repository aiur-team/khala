import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeTarget } from './teardown.ts';

const target = {
  v: 1, purpose: 'khala-134-disposable-preview',
  railwayProjectId: '9f30bc02-e7b5-45c4-95f4-e50b10034696',
  railwayEnvironmentId: '11111111-1111-4111-8111-111111111111',
  railwayEnvironmentName: 'preview-kha134-abcdef',
  netlifySiteId: '22222222-2222-4222-8222-222222222222',
  netlifySiteName: 'khala-134-preview-abcdef',
  teardownAfter: '2026-09-28T00:00:00Z',
};

test('only an exact disposable preview target can reach provider preflight', () => {
  assert.deepEqual(decodeTarget(target), target);
  for (const change of [
    { railwayEnvironmentId: '6ca01f48-1cc9-40f1-aa84-31e2bdc376dc' },
    { railwayEnvironmentName: 'production' },
    { netlifySiteId: 'e95155c4-1070-46f8-95eb-4ca86df16030' },
    { netlifySiteName: 'khala-aiur' },
    { railwayProjectId: '33333333-3333-4333-8333-333333333333' },
    { purpose: 'ordinary-deployment' },
    { teardownAfter: 'tomorrow' },
    { extra: 'not allowed' },
  ]) assert.throws(() => decodeTarget({ ...target, ...change }), /invalid-target/);
});
