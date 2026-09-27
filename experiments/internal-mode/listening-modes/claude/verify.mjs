// Offline validation of the redacted installed-CLI observations. This checks the
// retained facts and their causal order; the private native journal remains with
// the Executor and is required for an independent source audit.
import { readFileSync } from 'node:fs';

const CASES = ['idleSync', 'busySync', 'busySteer', 'idleSteer', 'async', 'pauseResume', 'restartRejoin', 'stop'];
const KEYS = {
  '': ['schema', 'claim', 'builds', 'cases', 'limitations'],
  claim: ['harness', 'version', 'route', 'model', 'ordinaryUserStartedCli', 'normalFolderTrust',
    'permissionOverride', 'sameNativeSession', 'source', 'watchWindowSeconds', 'immediateNotification'],
  builds: ['hook', 'mcpRepair'],
  'builds.hook': ['commit', 'tarballSha256'],
  'builds.mcpRepair': ['commit', 'tarballSha256'],
  cases: CASES,
  'cases.idleSync': ['sentAt', 'nativeJournalOccurrences', 'firstNativeAt', 'lastNativeAt',
    'idleBeforeSendSeconds', 'nativeContextAt', 'nativeAssistantAt', 'sameSession',
    'bodySeenInNativeContextAndResponse'],
  'cases.busySync': ['sentAt', 'nativeJournalOccurrences', 'firstNativeAt', 'lastNativeAt',
    'toolFinishedAt', 'nativeContextAt', 'nativeAssistantAt', 'receiptsBeforeNextCall', 'receiptsAfterNextCall'],
  'cases.busySteer': ['sentAt', 'nativeJournalOccurrences', 'firstNativeAt', 'lastNativeAt',
    'toolStartedAt', 'toolFinishedAt', 'postToolContextAt', 'nextToolAt', 'nativeAssistantAt',
    'receiptsBeforeNextCall', 'receiptsAfterNextCall'],
  'cases.idleSteer': ['sentAt', 'nativeJournalOccurrences', 'firstNativeAt', 'lastNativeAt',
    'idleBeforeSendSeconds', 'sameWatcherNonce', 'nativeContextAt', 'nativeAssistantAt',
    'receiptsBeforeNextCall', 'receiptsAfterNextCall'],
  'cases.async': ['sentAt', 'nativeJournalOccurrences', 'firstNativeAt', 'lastNativeAt',
    'noAutomaticDeliverySeconds', 'noAutomaticDeliveryAcrossToolsAndStop',
    'nativeToolCallsBeforeRead', 'nativeStopBoundariesBeforeRead', 'nativeReadAt',
    'nativeAssistantAt', 'bodySeenInNativeReadAndResponse', 'receiptFactsBeforeNextCall',
    'freshEventAbsentBeforeNextCall', 'receiptFactsAfterNextCall', 'freshEventAcknowledgedAfterNextCall'],
  'cases.pauseResume': ['sentAt', 'nativeJournalOccurrences', 'firstNativeAt', 'lastNativeAt',
    'heldAcrossToolsStopAndRead', 'pausedReadAt', 'pausedReadKind', 'receiptsWhilePaused',
    'resumedNativeContextAt', 'resumedNativeAssistantAt', 'receiptsAfterNextCall'],
  'cases.restartRejoin': ['sameNativeSession', 'oldLaunchCapabilityRefused', 'approvedOperationReused',
    'reactivatedAfterExplicitNativeRequest'],
  'cases.stop': ['stoppedBindings', 'remainingBindings', 'nativeReadAt', 'nativeReadRefusedUnbound',
    'postStopMarkerAbsent', 'receiptsAfterStop', 'sameCliAlive', 'nativeBashAfterStopCompleted'],
  limitations: ['previousAsyncBatchExcluded', 'finalApplicationCandidate', 'unboundedIdleWakeProven',
    'agentToAgentAutomaticWakeProven',
    'privateRawRetainedOutsideRepository'],
};

function requireFact(ok, field) {
  if (!ok) throw new Error(`Claude mode evidence invalid at ${field}`);
}

function exactKeys(value, path) {
  const expected = KEYS[path];
  requireFact(value !== null && typeof value === 'object' && !Array.isArray(value), path || 'root');
  requireFact(expected.length === Object.keys(value).length && expected.every(key => Object.hasOwn(value, key)), path || 'root');
  for (const key of expected) {
    const child = path ? `${path}.${key}` : key;
    if (KEYS[child]) exactKeys(value[key], child);
  }
}

function at(value, field) {
  requireFact(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/.test(value)
    && Number.isFinite(Date.parse(value)), field);
  return Date.parse(value);
}

function before(first, second, field, tolerance = 0) {
  requireFact(first <= second + tolerance, field);
}

function bool(value, expected, field) { requireFact(value === expected, field); }
function count(value, field) { requireFact(Number.isSafeInteger(value) && value >= 0, field); }
function receipt(beforeCount, afterCount, field) {
  count(beforeCount, field); count(afterCount, field);
  requireFact(afterCount === beforeCount + 1, field);
}

function journal(caseName, row) {
  const sent = at(row.sentAt, `${caseName}.sentAt`);
  const first = at(row.firstNativeAt, `${caseName}.firstNativeAt`);
  const last = at(row.lastNativeAt, `${caseName}.lastNativeAt`);
  count(row.nativeJournalOccurrences, `${caseName}.nativeJournalOccurrences`);
  requireFact(row.nativeJournalOccurrences >= 2, `${caseName}.nativeJournalOccurrences`);
  before(sent, first, `${caseName}.deliveryOrder`);
  before(first, last, `${caseName}.journalOrder`);
  return { sent, first, last };
}

/** Strictly validates one content-free public summary; never includes a rejected value in errors. */
export function verifyEvidence(evidence) {
  exactKeys(evidence, '');
  const { claim, builds, cases: c, limitations } = evidence;
  requireFact(evidence.schema === 1, 'schema');
  requireFact(claim.harness === 'claude' && claim.version === '2.1.283'
    && claim.route === 'claude-interactive-hooks' && claim.model === 'claude-sonnet-5'
    && claim.source === 'human-authored-channel-messages', 'claim');
  bool(claim.ordinaryUserStartedCli, false, 'claim.ordinaryUserStartedCli');
  bool(claim.normalFolderTrust, true, 'claim.normalFolderTrust');
  bool(claim.permissionOverride, false, 'claim.permissionOverride');
  bool(claim.sameNativeSession, true, 'claim.sameNativeSession');
  requireFact(claim.watchWindowSeconds === 3000 && claim.immediateNotification === 'unknown', 'claim.idleWindow');
  for (const [name, build] of Object.entries(builds)) {
    requireFact(typeof build.commit === 'string' && /^[0-9a-f]{40}$/.test(build.commit), `builds.${name}.commit`);
    requireFact(typeof build.tarballSha256 === 'string' && /^[0-9a-f]{64}$/.test(build.tarballSha256),
      `builds.${name}.tarballSha256`);
  }
  requireFact(builds.hook.commit.startsWith('7e6be40') && builds.mcpRepair.commit.startsWith('08bac82')
    && builds.hook.commit !== builds.mcpRepair.commit, 'builds.lineage');

  const idleSync = journal('idleSync', c.idleSync);
  requireFact(c.idleSync.idleBeforeSendSeconds > 40 && c.idleSync.idleBeforeSendSeconds < 3000,
    'idleSync.idleBeforeSendSeconds');
  bool(c.idleSync.sameSession, true, 'idleSync.sameSession');
  bool(c.idleSync.bodySeenInNativeContextAndResponse, true, 'idleSync.bodySeenInNativeContextAndResponse');
  requireFact(at(c.idleSync.nativeContextAt, 'idleSync.nativeContextAt') === idleSync.first, 'idleSync.nativeContextAt');
  requireFact(at(c.idleSync.nativeAssistantAt, 'idleSync.nativeAssistantAt') === idleSync.last, 'idleSync.nativeAssistantAt');

  const busySync = journal('busySync', c.busySync);
  before(busySync.sent, at(c.busySync.toolFinishedAt, 'busySync.toolFinishedAt'), 'busySync.busyOrder');
  before(at(c.busySync.toolFinishedAt, 'busySync.toolFinishedAt'), busySync.first, 'busySync.stopBoundary');
  requireFact(at(c.busySync.nativeContextAt, 'busySync.nativeContextAt') === busySync.first, 'busySync.nativeContextAt');
  before(busySync.first, at(c.busySync.nativeAssistantAt, 'busySync.nativeAssistantAt'), 'busySync.responseOrder');
  receipt(c.busySync.receiptsBeforeNextCall, c.busySync.receiptsAfterNextCall, 'busySync.receipts');

  const busySteer = journal('busySteer', c.busySteer);
  before(at(c.busySteer.toolStartedAt, 'busySteer.toolStartedAt'), busySteer.sent, 'busySteer.busyOrder');
  before(busySteer.sent, at(c.busySteer.toolFinishedAt, 'busySteer.toolFinishedAt'), 'busySteer.busyOrder');
  const postTool = at(c.busySteer.postToolContextAt, 'busySteer.postToolContextAt');
  before(at(c.busySteer.toolFinishedAt, 'busySteer.toolFinishedAt'), postTool, 'busySteer.postToolBoundary', 100);
  requireFact(postTool === busySteer.first, 'busySteer.postToolContextAt');
  before(postTool, at(c.busySteer.nextToolAt, 'busySteer.nextToolAt'), 'busySteer.nextToolOrder');
  before(postTool, at(c.busySteer.nativeAssistantAt, 'busySteer.nativeAssistantAt'), 'busySteer.responseOrder');
  receipt(c.busySteer.receiptsBeforeNextCall, c.busySteer.receiptsAfterNextCall, 'busySteer.receipts');

  const idleSteer = journal('idleSteer', c.idleSteer);
  requireFact(c.idleSteer.idleBeforeSendSeconds > 40 && c.idleSteer.idleBeforeSendSeconds < 3000,
    'idleSteer.idleBeforeSendSeconds');
  bool(c.idleSteer.sameWatcherNonce, true, 'idleSteer.sameWatcherNonce');
  requireFact(at(c.idleSteer.nativeContextAt, 'idleSteer.nativeContextAt') === idleSteer.first, 'idleSteer.nativeContextAt');
  requireFact(at(c.idleSteer.nativeAssistantAt, 'idleSteer.nativeAssistantAt') === idleSteer.last, 'idleSteer.nativeAssistantAt');
  receipt(c.idleSteer.receiptsBeforeNextCall, c.idleSteer.receiptsAfterNextCall, 'idleSteer.receipts');

  const async = journal('async', c.async);
  requireFact(c.async.noAutomaticDeliverySeconds > 40, 'async.noAutomaticDeliverySeconds');
  bool(c.async.noAutomaticDeliveryAcrossToolsAndStop, true, 'async.noAutomaticDeliveryAcrossToolsAndStop');
  requireFact(c.async.nativeToolCallsBeforeRead >= 2 && Number.isSafeInteger(c.async.nativeToolCallsBeforeRead),
    'async.nativeToolCallsBeforeRead');
  requireFact(c.async.nativeStopBoundariesBeforeRead >= 1 && Number.isSafeInteger(c.async.nativeStopBoundariesBeforeRead),
    'async.nativeStopBoundariesBeforeRead');
  bool(c.async.bodySeenInNativeReadAndResponse, true, 'async.bodySeenInNativeReadAndResponse');
  bool(c.async.freshEventAbsentBeforeNextCall, true, 'async.freshEventAbsentBeforeNextCall');
  bool(c.async.freshEventAcknowledgedAfterNextCall, true, 'async.freshEventAcknowledgedAfterNextCall');
  requireFact(at(c.async.nativeReadAt, 'async.nativeReadAt') === async.first, 'async.nativeReadAt');
  requireFact(at(c.async.nativeAssistantAt, 'async.nativeAssistantAt') === async.last, 'async.nativeAssistantAt');
  receipt(c.async.receiptFactsBeforeNextCall, c.async.receiptFactsAfterNextCall, 'async.receipts');

  const pause = journal('pauseResume', c.pauseResume);
  bool(c.pauseResume.heldAcrossToolsStopAndRead, true, 'pauseResume.heldAcrossToolsStopAndRead');
  requireFact(c.pauseResume.pausedReadKind === 'empty', 'pauseResume.pausedReadKind');
  before(pause.sent, at(c.pauseResume.pausedReadAt, 'pauseResume.pausedReadAt'), 'pauseResume.heldOrder');
  before(at(c.pauseResume.pausedReadAt, 'pauseResume.pausedReadAt'), pause.first, 'pauseResume.resumeOrder');
  requireFact(at(c.pauseResume.resumedNativeContextAt, 'pauseResume.resumedNativeContextAt') === pause.first,
    'pauseResume.resumedNativeContextAt');
  requireFact(at(c.pauseResume.resumedNativeAssistantAt, 'pauseResume.resumedNativeAssistantAt') === pause.last,
    'pauseResume.resumedNativeAssistantAt');
  requireFact(c.pauseResume.receiptsWhilePaused === c.async.receiptFactsAfterNextCall, 'pauseResume.receiptsWhilePaused');
  receipt(c.pauseResume.receiptsWhilePaused, c.pauseResume.receiptsAfterNextCall, 'pauseResume.receipts');

  for (const [key, value] of Object.entries(c.restartRejoin)) bool(value, true, `restartRejoin.${key}`);

  count(c.stop.stoppedBindings, 'stop.stoppedBindings');
  requireFact(c.stop.stoppedBindings === 1 && c.stop.remainingBindings === 0, 'stop.bindings');
  before(pause.last, at(c.stop.nativeReadAt, 'stop.nativeReadAt'), 'stop.readOrder');
  bool(c.stop.nativeReadRefusedUnbound, true, 'stop.nativeReadRefusedUnbound');
  bool(c.stop.postStopMarkerAbsent, true, 'stop.postStopMarkerAbsent');
  bool(c.stop.sameCliAlive, true, 'stop.sameCliAlive');
  bool(c.stop.nativeBashAfterStopCompleted, true, 'stop.nativeBashAfterStopCompleted');
  requireFact(c.stop.receiptsAfterStop === c.pauseResume.receiptsAfterNextCall, 'stop.receiptsAfterStop');

  bool(limitations.previousAsyncBatchExcluded, true, 'limitations.previousAsyncBatchExcluded');
  bool(limitations.finalApplicationCandidate, false, 'limitations.finalApplicationCandidate');
  bool(limitations.unboundedIdleWakeProven, false, 'limitations.unboundedIdleWakeProven');
  bool(limitations.agentToAgentAutomaticWakeProven, false, 'limitations.agentToAgentAutomaticWakeProven');
  bool(limitations.privateRawRetainedOutsideRepository, true, 'limitations.privateRawRetainedOutsideRepository');
  return true;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    verifyEvidence(JSON.parse(readFileSync(process.argv[2] ?? new URL('./evidence.json', import.meta.url), 'utf8')));
    console.log('Claude 2.1.283 redacted mode evidence valid');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Claude mode evidence invalid');
    process.exitCode = 1;
  }
}
