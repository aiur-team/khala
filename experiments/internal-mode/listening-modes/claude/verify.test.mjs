import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyEvidence } from './verify.mjs';

const evidence = JSON.parse(readFileSync(new URL('./evidence.json', import.meta.url), 'utf8'));
const changed = edit => {
  const copy = structuredClone(evidence);
  edit(copy);
  return copy;
};

test('retained sanitized Claude mode run passes the offline checks', () => {
  assert.equal(verifyEvidence(evidence), true);
});

test('only the exact normal-trust version and finite watcher claim pass', () => {
  for (const edit of [
    value => { value.claim.version = '2.1.284'; },
    value => { value.claim.permissionOverride = true; },
    value => { value.claim.ordinaryUserStartedCli = true; },
    value => { value.claim.watchWindowSeconds = 3600; },
    value => { value.claim.immediateNotification = 'native_cli_queue'; },
    value => { value.limitations.unboundedIdleWakeProven = true; },
    value => { value.builds.mcpRepair = value.builds.hook; },
  ]) assert.throws(() => verifyEvidence(changed(edit)), /Claude mode evidence invalid/);
});

test('wrong implementation: an idle wake within the old 40-second window cannot prove idle delivery', () => {
  for (const mode of ['idleSync', 'idleSteer']) {
    assert.throws(() => verifyEvidence(changed(value => { value.cases[mode].idleBeforeSendSeconds = 20; })),
      /idleBeforeSendSeconds/);
  }
});

test('wrong implementation: async hook delivery or a lost native read cannot be promoted', () => {
  for (const edit of [
    value => { value.cases.async.noAutomaticDeliveryAcrossToolsAndStop = false; },
    value => { value.cases.async.nativeStopBoundariesBeforeRead = 0; },
    value => { value.cases.async.bodySeenInNativeReadAndResponse = false; },
    value => { value.cases.async.freshEventAbsentBeforeNextCall = false; },
    value => { value.cases.async.freshEventAcknowledgedAfterNextCall = false; },
    value => { value.cases.async.receiptFactsAfterNextCall = value.cases.async.receiptFactsBeforeNextCall; },
  ]) assert.throws(() => verifyEvidence(changed(edit)), /Claude mode evidence invalid/);
});

test('pause and Stop require no early release, no post-Stop binding, and a live CLI', () => {
  for (const edit of [
    value => { value.cases.pauseResume.pausedReadKind = 'batch'; },
    value => { value.cases.pauseResume.heldAcrossToolsStopAndRead = false; },
    value => { value.cases.restartRejoin.oldLaunchCapabilityRefused = false; },
    value => { value.cases.stop.remainingBindings = 1; },
    value => { value.cases.stop.nativeReadRefusedUnbound = false; },
    value => { value.cases.stop.postStopMarkerAbsent = false; },
    value => { value.cases.stop.sameCliAlive = false; },
  ]) assert.throws(() => verifyEvidence(changed(edit)), /Claude mode evidence invalid/);
});

test('retained artifact rejects undeclared raw fields and inconsistent timing', () => {
  assert.throws(() => verifyEvidence(changed(value => { value.cases.async.marker = 'private'; })),
    /Claude mode evidence invalid/);
  assert.throws(() => verifyEvidence(changed(value => { value.cases.busySteer.nextToolAt = value.cases.busySteer.toolStartedAt; })),
    /Claude mode evidence invalid/);
  assert.throws(() => verifyEvidence(changed(value => { value.cases.idleSync.nativeJournalOccurrences = 0; })),
    /Claude mode evidence invalid/);
});
