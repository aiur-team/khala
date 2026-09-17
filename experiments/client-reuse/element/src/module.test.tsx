import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleLoader } from '@element-hq/element-web-module-api';
import { ModuleLoader as PreviousLoader } from 'module-api-previous';
import FixtureModule from './module';
import { makeHarness } from './harness';
import { batch, fixtureReviewPort } from '../../fixtures/scenario';
// Package copies brand Watchable with distinct private fields. This cast is only
// for runtime loader replay against our deliberately partial synthetic host.
for (const [version, Loader] of [['2.0.0', PreviousLoader as unknown as typeof ModuleLoader], ['2.1.0', ModuleLoader]] as const) {
  test(`real ModuleLoader ${version} registers fixture route`, async () => { const host = makeHarness(); const loader = new Loader(host.api); await loader.load({ default: FixtureModule }); await loader.start(); assert(host.renderers.has('khala-fixture')); });
}
test('incompatible module rejects instead of silently losing review', async () => { class Wrong extends FixtureModule { static readonly moduleApiVersion = '^999.0.0'; } await assert.rejects(new ModuleLoader(makeHarness().api).load({ default: Wrong })); });
test('review preserves exact fixture digest and policy/binding generations', async () => { assert.equal(await fixtureReviewPort().approve(batch), 'unknown'); await assert.rejects(fixtureReviewPort().approve({ ...batch, digest: 'changed' })); });
