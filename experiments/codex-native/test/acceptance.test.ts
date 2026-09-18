import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assessNativeQueue, type NativeQueueReport } from '../acceptance.ts';

const fixture = new URL('../evidence/live-run.json', import.meta.url);
const load = async (): Promise<NativeQueueReport> => JSON.parse(await readFile(fixture, 'utf8')) as NativeQueueReport;

test('live evidence selects notification-only route A and route B for bytes', async () => {
  const verdict = assessNativeQueue(await load());
  assert.deepEqual(verdict, {
    route: 'route_a_notification_route_b_bytes',
    existingSession: true,
    immediateNotification: true,
    busyQueues: true,
    payloadCanUseStdin: false,
    reconcileByReleaseId: false,
    failures: [],
  });
});

test('a missing same-TUI observation fails closed to route B', async () => {
  const report = await load();
  report.cases.liveOwner.consumedByTui = false;
  const verdict = assessNativeQueue(report);
  assert.equal(verdict.route, 'route_b');
  assert.match(verdict.failures.join('\n'), /live TUI delivery/);
});

test('a proved stdin sentinel upgrades route A to carry bytes', async () => {
  const report = await load();
  report.cases.stdinDash.observedUserText = 'released bytes';
  report.cases.stdinDash.pipedPayloadObserved = true;
  const verdict = assessNativeQueue(report);
  assert.equal(verdict.route, 'route_a');
  assert.equal(verdict.payloadCanUseStdin, true);
  assert.deepEqual(verdict.failures, []);
});

test('busy acceptance requires queueing before the active turn completes', async () => {
  const report = await load();
  report.cases.busy.queueAcceptedAt = report.cases.busy.consumedAt;
  const verdict = assessNativeQueue(report);
  assert.equal(verdict.busyQueues, false);
  assert.match(verdict.failures.join('\n'), /busy delivery/);
});

test('unsafe errors and duplicate collapse are rejected', async () => {
  const report = await load();
  report.cases.missingThread.payloadEchoed = true;
  report.cases.duplicate.consumptionCount = 1;
  const verdict = assessNativeQueue(report);
  assert.match(verdict.failures.join('\n'), /duplicate delivery/);
  assert.match(verdict.failures.join('\n'), /missing-thread error/);
});
