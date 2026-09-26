// Installed delivery: for each harness Khala installs an entry for, the entry exactly as
// setup wrote it into that harness's config delivers end to end against the installed
// `khala internal`, or, where the route is intentionally unproven, refuses honestly.
// Package and integration tests passed twice while an installed runtime path was never
// wired (#418, #430); only a live proof caught either. This suite is that proof in CI,
// black-box against the packed tarball. See README.md in this directory.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { installTarball, packedTarball, removeScratch } from '../../integration/agent-setup/harness.mjs';
import { JOURNEYS, runJourney } from './journeys.mjs';
import { DeliveryFailure, setUpMachine } from './world.mjs';

const HARNESSES = Object.keys(JOURNEYS);
let packed;
let install;

before(() => {
  packed = packedTarball();
  install = installTarball(packed.tarball);
});

after(() => {
  packed?.cleanup();
  if (process.env.KHALA_SETUP_KEEP !== '1') removeScratch();
});

test('setup installs entries for exactly the harnesses this suite proves', () => {
  const { status } = setUpMachine(install);
  const installed = status.harnesses.filter(entry => entry.components.length > 0).map(entry => entry.harness);
  // A harness setup newly installs for needs a journey here before it ships.
  assert.deepEqual(installed.sort(), [...HARNESSES].sort());
});

describe('each installed entry delivers end to end', () => {
  for (const harness of HARNESSES) {
    test(`${harness}: join, owner approval, one delivered message, khala_read, next-call ack, Stop ends delivery`, () =>
      runJourney(install, harness));
  }
});

// Wrong-implementation check: with one harness's installed entry rewritten, in its own
// config, to a stub that binds nothing, that harness's journey fails and names it.
describe('a stubbed entry fails its own harness', () => {
  for (const harness of HARNESSES) {
    test(`${harness} with a stub entry fails as ${harness}`, () =>
      assert.rejects(runJourney(install, harness, { stub: true }), error => {
        assert.ok(error instanceof DeliveryFailure, `not a delivery failure: ${error.stack}`);
        assert.equal(error.harness, harness);
        assert.match(error.message, new RegExp(`^\\[${harness}\\] `));
        return true;
      }));
  }
});
