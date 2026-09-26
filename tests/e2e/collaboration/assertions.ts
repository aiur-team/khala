// The KHA-139 acceptance assertions, each a check over live evidence records. Records
// hold identifiers only. Order is compared within one owner's clock, never across
// owners, and a relay or transport receipt is never read as model consumption.

import type { EvidenceRecord } from '../harness/evidence';
import type { CollaborationCase, GateId } from './scenario';

export type Verdict =
  | Readonly<{ passed: true; evidenceRef: string }>
  | Readonly<{ passed: false; reason: string }>;

export type AssertionSpec = Readonly<{
  id: string;
  /** Plan requirements (R*) and acceptance examples (AE*) this assertion covers. */
  covers: readonly string[];
  unit: 'U2' | 'U3' | 'U4';
  /** Open gates that turn this row into `blocked` instead of checking it. */
  gates: readonly GateId[];
  check(records: readonly EvidenceRecord[], acceptance: CollaborationCase): Verdict;
}>;

const pass = (evidenceRef: string): Verdict => ({ passed: true, evidenceRef });
const fail = (reason: string): Verdict => ({ passed: false, reason });

/** `<kind>/<operationId>` for one record; the report prefixes the run id. */
export const ref = (record: EvidenceRecord): string => `${record.kind}/${record.operationId}`;

const owned = (records: readonly EvidenceRecord[], ownerId: string, kind: string) =>
  records.filter(record => record.ownerId === ownerId && record.kind === kind);

/** Same owner, same clock: `a` happened before `b`. Log order breaks equal readings. */
function before(records: readonly EvidenceRecord[], a: EvidenceRecord, b: EvidenceRecord): boolean {
  if (a.clockId !== b.clockId) throw new Error(`cannot order ${ref(a)} and ${ref(b)} across clocks`);
  return a.at < b.at || (a.at === b.at && records.indexOf(a) < records.indexOf(b));
}

const first = (records: readonly EvidenceRecord[], candidates: readonly EvidenceRecord[], after?: EvidenceRecord) =>
  candidates.find(candidate => after === undefined || before(records, after, candidate));

/** Kinds meaning released content entered a model's context. Receipts never do. */
const CONSUMPTION: readonly string[] = ['model.input', 'context.consumed'];

/**
 * An auto-release counts only under the same owner's own trust: requested, then
 * effective, and not re-armed between that and the auto-release.
 */
function trusted(records: readonly EvidenceRecord[], auto: EvidenceRecord): boolean {
  const own = (kind: string) => owned(records, auto.ownerId, kind);
  return own('trust.effective').some(effective => before(records, effective, auto)
    && own('trust.requested').some(request => before(records, request, effective))
    && !own('trust.rearmed').some(rearm => before(records, effective, rearm) && before(records, rearm, auto)));
}

/**
 * Everything the owner's model consumed follows that owner's own release of the same
 * operation, by review or under that owner's effective trust. Another owner's release
 * never counts.
 */
function gatedConsumption(records: readonly EvidenceRecord[], ownerId: string, requireAny: boolean): Verdict {
  const consumed = records.filter(record => record.ownerId === ownerId && CONSUMPTION.includes(record.kind));
  if (requireAny && owned(records, ownerId, 'model.input').length === 0) return fail(`no model.input recorded for ${ownerId}`);
  for (const entry of consumed) {
    const released = (candidate: EvidenceRecord) => candidate.operationId === entry.operationId && before(records, candidate, entry);
    const reviewed = owned(records, ownerId, 'review.released').some(released);
    const auto = owned(records, ownerId, 'trust.auto_released').some(candidate => released(candidate) && trusted(records, candidate));
    if (!reviewed && !auto) return fail(`${ref(entry)} reached ${ownerId}'s model context without ${ownerId}'s own release`);
  }
  return pass(consumed.length > 0 ? consumed.map(ref).join(',') : `none/${ownerId}`);
}

function onboarded(records: readonly EvidenceRecord[], ownerId: string): Verdict {
  for (const kind of ['setup.oauth_signed_in', 'setup.link_joined', 'setup.session_bound']) {
    if (owned(records, ownerId, kind).length === 0) return fail(`${ownerId} has no ${kind}`);
  }
  return pass(`setup/${ownerId}`);
}

export const ASSERTIONS: readonly AssertionSpec[] = Object.freeze([
  {
    id: 'ordinary_onboarding', covers: ['R1'], unit: 'U2', gates: [],
    check(records, acceptance) {
      const configured = records.find(record => record.kind === 'setup.human_configured');
      if (configured) return fail(`${configured.ownerId} performed technical connector setup (${ref(configured)})`);
      for (const owner of acceptance.owners) {
        const verdict = onboarded(records, owner.ownerId);
        if (!verdict.passed) return verdict;
      }
      return pass('setup/all-owners');
    },
  },
  {
    id: 'exact_review_release', covers: ['R2', 'AE1'], unit: 'U2', gates: [],
    check(records, acceptance) {
      const b = acceptance.owners[1].ownerId;
      const released = owned(records, b, 'review.released');
      if (released.length === 0) return fail(`${b} released nothing for review`);
      for (const release of released) {
        const preview = owned(records, b, 'review.previewed').find(candidate =>
          candidate.operationId === release.operationId && before(records, candidate, release));
        if (!preview) return fail(`${ref(release)} was released without ${b} previewing the exact content first`);
      }
      return gatedConsumption(records, b, true);
    },
  },
  {
    id: 'no_unreleased_consumption', covers: ['R2', 'AE1'], unit: 'U2', gates: [],
    check(records, acceptance) {
      for (const owner of acceptance.owners) {
        const verdict = gatedConsumption(records, owner.ownerId, false);
        if (!verdict.passed) return verdict;
      }
      return pass('consumption/all-owners');
    },
  },
  {
    id: 'session_identity_retained', covers: ['AE1'], unit: 'U2', gates: [],
    check(records, acceptance) {
      const changed = records.find(record => record.kind === 'session.identity_changed');
      if (changed) return fail(`${changed.ownerId}'s session identity changed (${ref(changed)})`);
      const b = acceptance.owners[1].ownerId;
      if (owned(records, b, 'model.input').length === 0) return fail(`no model.input recorded for ${b}`);
      for (const owner of acceptance.owners.slice(0, 2)) {
        for (const input of owned(records, owner.ownerId, 'model.input')) {
          const matched = owned(records, owner.ownerId, 'session.identity_matched')
            .some(candidate => candidate.operationId === input.operationId);
          if (!matched) return fail(`${ref(input)} has no session.identity_matched for ${owner.ownerId}`);
        }
      }
      return pass('session.identity_matched');
    },
  },
  {
    id: 'useful_task_result', covers: ['R1', 'AE1'], unit: 'U2', gates: ['G-TASK'],
    check(records, acceptance) {
      const consumed = new Set(records.filter(record => record.kind === 'model.input').map(record => record.operationId));
      const refs: string[] = [];
      for (const id of acceptance.expectedTaskAssertions) {
        const result = records.find(record => record.kind === `task.${id}` && consumed.has(record.operationId));
        if (!result) return fail(`task.${id} was not recorded against a message a model consumed`);
        refs.push(ref(result));
      }
      return pass(refs.join(','));
    },
  },
  {
    id: 'trusted_delivery', covers: ['R2'], unit: 'U3', gates: ['G-AUTOMATION'],
    check(records, acceptance) {
      const b = acceptance.owners[1].ownerId;
      const requested = owned(records, b, 'trust.requested')[0];
      if (!requested) return fail(`${b} never requested trusted delivery`);
      const effective = first(records, owned(records, b, 'trust.effective'), requested);
      if (!effective) return fail(`${b}'s trusted mode was requested but never became effective`);
      const auto = first(records, owned(records, b, 'trust.auto_released'), effective);
      if (!auto) return fail(`no message was released under ${b}'s effective trust`);
      return pass(`${ref(effective)},${ref(auto)}`);
    },
  },
  {
    id: 'rearm_waits', covers: ['R2'], unit: 'U3', gates: ['G-AUTOMATION'],
    check(records, acceptance) {
      const b = acceptance.owners[1].ownerId;
      const rearm = owned(records, b, 'trust.rearmed')[0];
      if (!rearm) return fail(`${b} never re-armed review`);
      const leaked = first(records, owned(records, b, 'trust.auto_released'), rearm);
      if (leaked) return fail(`${ref(leaked)} bypassed review after ${b} re-armed it`);
      const waiting = first(records, owned(records, b, 'review.pending'), rearm);
      if (!waiting) return fail(`no message waited for ${b}'s review after re-arm`);
      const early = owned(records, b, 'model.input').find(input => input.operationId === waiting.operationId
        && !owned(records, b, 'review.released').some(release =>
          release.operationId === input.operationId && before(records, release, input)));
      if (early) return fail(`${ref(early)} reached ${b}'s model before review after re-arm`);
      return pass(ref(waiting));
    },
  },
  {
    id: 'third_owner_independent', covers: ['R2'], unit: 'U3', gates: [],
    check(records, acceptance) {
      const c = acceptance.owners[2].ownerId;
      const joined = onboarded(records, c);
      if (!joined.passed) return joined;
      // B's trust or releases never stand in for C's own.
      return gatedConsumption(records, c, true);
    },
  },
  {
    id: 'third_owner_history', covers: ['R2'], unit: 'U3', gates: ['G-RETENTION'],
    check(records, acceptance) {
      const c = acceptance.owners[2].ownerId;
      const admitted = owned(records, c, 'history.admitted')[0];
      if (!admitted) return fail(`${c}'s admission point is not recorded`);
      const earlier = owned(records, c, 'history.pre_admission_read')[0];
      if (earlier) return fail(`${c} read history from before admission (${ref(earlier)}) under a no-earlier-history link`);
      return pass(ref(admitted));
    },
  },
  {
    id: 'busy_notified_then_consumed', covers: ['R3', 'AE2'], unit: 'U4', gates: ['G-AUTOMATION'],
    check(records) {
      const refs: string[] = [];
      for (const busy of records.filter(record => record.kind === 'session.busy')) {
        const queued = owned(records, busy.ownerId, 'delivery.queued')
          .find(candidate => candidate.operationId === busy.operationId && before(records, busy, candidate));
        if (!queued) continue;
        const consumed = owned(records, busy.ownerId, 'context.consumed')
          .find(candidate => candidate.operationId === busy.operationId && before(records, queued, candidate));
        if (!consumed) return fail(`${ref(queued)} was queued for a busy session but consumption was never observed`);
        refs.push(ref(queued), ref(consumed));
      }
      return refs.length > 0 ? pass(refs.join(',')) : fail('no busy recipient was exercised with a queued message');
    },
  },
  {
    id: 'offline_not_consumed', covers: ['R3', 'AE2'], unit: 'U4', gates: [],
    check(records) {
      const episodes = records.filter(record => record.kind === 'presence.offline');
      if (episodes.length === 0) return fail('no participant went offline');
      let relayed = 0;
      for (const offline of episodes) {
        const own = (kind: string) => owned(records, offline.ownerId, kind);
        const online = first(records, own('presence.online'), offline);
        if (!online) return fail(`${offline.ownerId} never came back online to catch up`);
        const accepted = own('relay.accepted').filter(record => before(records, offline, record) && before(records, record, online));
        relayed += accepted.length;
        for (const relay of accepted) {
          const same = (candidate: EvidenceRecord) => candidate.operationId === relay.operationId;
          const consumed = own('context.consumed').find(same);
          if (!consumed) return fail(`${ref(relay)} was never consumed after catch-up`);
          if (before(records, consumed, online)) return fail(`${ref(consumed)} is credited while ${offline.ownerId} was offline`);
          const caughtUp = own('delivery.caught_up').find(candidate => same(candidate)
            && before(records, online, candidate) && before(records, candidate, consumed));
          if (!caughtUp) return fail(`${ref(consumed)} has no catch-up after ${offline.ownerId} reconnected`);
          const unknown = own('harness.outcome_unknown').find(candidate => same(candidate) && before(records, candidate, consumed));
          if (unknown) return fail(`${ref(unknown)} was unknown and later counted as consumed without new evidence`);
        }
      }
      if (relayed === 0) return fail('the relay accepted nothing for an offline participant');
      return pass(episodes.map(ref).join(','));
    },
  },
  {
    id: 'browser_closed', covers: ['R3'], unit: 'U4', gates: ['P02'],
    check(records, acceptance) {
      if (acceptance.browserClosedMode !== 'required') return pass(`decision/${acceptance.browserClosedMode}`);
      const closed = records.find(record => record.kind === 'browser.closed');
      if (!closed) return fail('browser-closed operation is required but no browser was closed');
      const consumed = first(records, owned(records, closed.ownerId, 'context.consumed'), closed);
      const reopened = first(records, owned(records, closed.ownerId, 'browser.opened'), closed);
      if (!consumed || (reopened && before(records, reopened, consumed))) {
        return fail(`${closed.ownerId}'s session consumed nothing while the browser was closed`);
      }
      return pass(`${ref(closed)},${ref(consumed)}`);
    },
  },
  {
    id: 'recovery_without_backfill', covers: ['R3'], unit: 'U4', gates: [],
    check(records) {
      const recovered = records.find(record => record.kind === 'recovery.completed');
      if (!recovered) return fail('no recovery was exercised');
      const backfill = records.find(record => record.kind === 'recovery.backfill');
      if (backfill) return fail(`${ref(backfill)} restored history, which P14 excludes`);
      return pass(ref(recovered));
    },
  },
]);
