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

const DELIVERS = "join, owner approval, one delivered message, khala_read, the next call advances the agent's read cursor, Stop ends delivery";
const TITLES = Object.freeze({
  claude: `claude: ${DELIVERS}`,
  codex: `codex: ${DELIVERS}`,
  opencode: `opencode: ${DELIVERS}`,
  cursor: 'cursor: approved binding refuses honestly (unproven route), Stop ends the binding',
});

// Internal mode records no agent acknowledgement yet, so the owner's receipts stay
// empty after the agent's next call (#442). Kept as todo, not dropped, until #442 lands.
const ACK_TODO = "#442: internal mode records no agent_acknowledged receipt";

describe('each installed entry delivers end to end', () => {
  for (const harness of HARNESSES) {
    test(TITLES[harness], async t => {
      const acknowledgement = await runJourney(install, harness);
      if (acknowledgement === undefined) return;
      await t.test(`${harness}: the owner's receipts show agent_acknowledged for the delivered message (#442)`, { todo: ACK_TODO }, () =>
        assert.ok(acknowledgement.acknowledged, `[${harness}] no agent_acknowledged receipt for ${acknowledgement.eventId}`));
    });
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
