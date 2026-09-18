export type NativeQueueReport = {
  schemaVersion: 1;
  codexVersion: string;
  target: { disposable: boolean; threadId: string; priorMarker: string };
  cases: {
    dormant: { socketBefore: 'absent' | 'present'; socketAfter: 'absent' | 'present'; exitCode: number; consumedAfterResume: boolean };
    liveOwner: { exitCode: number; queueId: string; consumedByTui: boolean; priorContextRecalled: boolean };
    stdinDash: { exitCode: number; observedUserText: string; pipedPayloadObserved: boolean };
    stdinAtDash: { exitCode: number; observedUserText: string; pipedPayloadObserved: boolean };
    duplicate: { distinctQueueIds: string[]; consumptionCount: number };
    busy: { queueAcceptedAt: string; sourceCompletedAt: string; consumedAt: string; consumedInLaterTurn: boolean };
    killed: { signal: string; receiptObserved: boolean; messageLanded: boolean };
    missingThread: { exitCode: number; payloadEchoed: boolean };
  };
  correlation: { cliAcceptsClientMessageId: boolean; queueIdPresentAtConsumption: boolean };
};

export type NativeQueueVerdict = {
  route: 'route_a' | 'route_a_notification_route_b_bytes' | 'route_b';
  existingSession: boolean;
  immediateNotification: boolean;
  busyQueues: boolean;
  payloadCanUseStdin: boolean;
  reconcileByReleaseId: boolean;
  failures: string[];
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assessNativeQueue(report: NativeQueueReport): NativeQueueVerdict {
  const failures: string[] = [];
  if (report.schemaVersion !== 1) failures.push('unsupported report schema');
  if (report.codexVersion !== 'codex-cli 0.154.0') failures.push('unproved Codex version');
  if (!report.target.disposable || !uuid.test(report.target.threadId)) failures.push('target was not a designated disposable thread');

  const existingSession = report.cases.liveOwner.exitCode === 0
    && uuid.test(report.cases.liveOwner.queueId)
    && report.cases.liveOwner.consumedByTui
    && report.cases.liveOwner.priorContextRecalled;
  if (!existingSession) failures.push('live TUI delivery did not preserve prior context');

  const immediateNotification = report.cases.dormant.exitCode === 0
    && report.cases.dormant.consumedAfterResume
    && report.cases.dormant.socketBefore === 'absent'
    && report.cases.dormant.socketAfter === 'absent';
  if (!immediateNotification) failures.push('dormant queue did not persist independently of the daemon socket');

  const payloadCanUseStdin = (report.cases.stdinDash.pipedPayloadObserved && report.cases.stdinDash.observedUserText !== '-')
    || (report.cases.stdinAtDash.pipedPayloadObserved && report.cases.stdinAtDash.observedUserText !== '@-');

  const accepted = Date.parse(report.cases.busy.queueAcceptedAt);
  const sourceCompleted = Date.parse(report.cases.busy.sourceCompletedAt);
  const consumed = Date.parse(report.cases.busy.consumedAt);
  const busyQueues = report.cases.busy.consumedInLaterTurn && accepted < sourceCompleted && sourceCompleted <= consumed;
  if (!busyQueues) failures.push('busy delivery was not observed waiting for the active turn');

  if (report.cases.duplicate.distinctQueueIds.length !== 2
    || new Set(report.cases.duplicate.distinctQueueIds).size !== 2
    || report.cases.duplicate.consumptionCount !== 2) {
    failures.push('duplicate delivery behavior was not observed twice');
  }
  if (report.cases.killed.signal !== 'SIGKILL' || report.cases.killed.receiptObserved || report.cases.killed.messageLanded) {
    failures.push('killed-process boundary was not fail-closed in this run');
  }
  if (report.cases.missingThread.exitCode === 0 || report.cases.missingThread.payloadEchoed) {
    failures.push('missing-thread error was unsafe');
  }

  const reconcileByReleaseId = report.correlation.cliAcceptsClientMessageId || report.correlation.queueIdPresentAtConsumption;
  const route = existingSession && immediateNotification
    ? (payloadCanUseStdin ? 'route_a' : 'route_a_notification_route_b_bytes')
    : 'route_b';
  return { route, existingSession, immediateNotification, busyQueues, payloadCanUseStdin, reconcileByReleaseId, failures };
}
