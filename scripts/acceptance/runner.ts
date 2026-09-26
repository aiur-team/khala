// The live acceptance run, in contract order: lock, status and preflight, one
// human-confirmed channel, the labelled ticket pair, grants, per-mode handshakes,
// the hold barrier, guarded Stop, launcher close, the post-shutdown snapshot, the
// verdict, and ownership-checked cleanup. Launcher close, cleanup and the lock
// release run in `finally` blocks, so a failure anywhere still closes the server
// and the tickets. The runner never starts, wraps or signals an agent.

import { sessionDigest } from '../../apps/internal/src/composition/channel-discovery/service';
import type { ListeningMode } from '../../packages/contracts/src/delivery/listening-mode';
import { planModes } from './profile';
import { controllerLine, markersFor, ownershipLine, ticketPrompt, ticketTitle } from './prompt';
import {
  ACCEPTANCE_LABEL, type AccessRequest, type ChannelSnapshot, type IssueRecord, type LaunchedServer, type Markers,
  type ModeRequest, type OwnerSession, type Profile, type ProfileRole, type RoleName, type RoleRecord, type RunReport,
  type RunnerDeps, type StagedPackage, type StopRecord, type StopTarget, type TimelineEvent,
} from './types';
import { verdictOf, verifyRun } from './verify';

export type RunOptions = Readonly<{
  profile: Profile;
  runId: string;
  /** Resume this persisted channel instead of creating one. */
  resume: string | null;
}>;

class Refused extends Error {}

const DEFAULT_POLL_MS = 2_000;

type MutableRole = { role: RoleName; ticket: number; session: RoleRecord['session']; target: StopTarget | null; granted: boolean };

function readyPattern(markers: Markers, role: RoleName): RegExp {
  return new RegExp(`^${markers.ready(role)} binding=([A-Za-z0-9_-]{1,256}) generation=(0|[1-9][0-9]{0,8})$`);
}

/** Each role's latest binding announcement, attributed by the server, never by the text. */
export function announcedTargets(timeline: readonly TimelineEvent[], markers: Markers): Map<RoleName, StopTarget | 'ambiguous'> {
  const targets = new Map<RoleName, StopTarget | 'ambiguous'>();
  for (const role of ['a', 'b'] as const) {
    const pattern = readyPattern(markers, role);
    for (const event of timeline) {
      const match = event.authorKind === 'agent' ? pattern.exec(event.body) : null;
      if (!match) continue;
      const previous = targets.get(role);
      if (previous === 'ambiguous') continue;
      if (previous && previous.agentParticipantId !== event.authorParticipantId) {
        targets.set(role, 'ambiguous');
        continue;
      }
      targets.set(role, { bindingId: match[1]!, generation: Number(match[2]), agentParticipantId: event.authorParticipantId });
    }
  }
  return targets;
}

function sameTarget(left: StopTarget, right: StopTarget): boolean {
  return left.bindingId === right.bindingId && left.generation === right.generation && left.agentParticipantId === right.agentParticipantId;
}

export async function runAcceptance(deps: RunnerDeps, options: RunOptions): Promise<RunReport> {
  const { profile } = options;
  const { clock, controller } = deps;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const plan = planModes(profile);
  const markers = markersFor(options.runId);
  const errors: string[] = [];
  const roles: MutableRole[] = [];
  const modeResults = new Map<ListeningMode, ModeRequest>();
  const cleanup: RunReport['cleanup'][number][] = [];
  let status: unknown = null;
  let stop: StopRecord | null = null;
  let timeline: readonly TimelineEvent[] = [];
  let snapshot: ChannelSnapshot | null = null;
  let launcherClosed = false;
  const issues: IssueRecord[] = [];
  let pullRequests: number[] = [];
  let refused: string | null = null;
  let staged: StagedPackage | null = null;
  const startedAt = new Date(clock.now()).toISOString();

  const report = (verdict: RunReport['verdict'], checks: RunReport['checks']): RunReport => ({
    profile: profile.name, repository: profile.repository, khalaPackage: staged?.record ?? null, verdict, checks, modes: plan,
    roles: roles.map(({ role, ticket, session, target }) => ({ role, ticket, session, target })),
    stop, launcherClosed, cleanup, unexpectedPullRequests: pullRequests, errors, status,
  });

  const lock = await deps.lock.acquire(profile.repository);
  if (!lock) {
    errors.push(`another live acceptance run holds the ${profile.repository} lock on this host`);
    return report('refused', []);
  }
  try {
    const deadline = clock.now() + profile.timeoutMs;
    const waitFor = async <T>(what: string, probe: () => Promise<T | null>): Promise<T> => {
      for (;;) {
        const value = await probe();
        if (value !== null) return value;
        if (clock.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
        await clock.sleep(pollMs);
      }
    };

    try {
      // Before any process starts: a tarball whose digest does not match refuses the run.
      staged = await deps.package.stage(profile.khalaPackage);
      status = (await deps.status.status(staged.spec)).output;
      const labels = [ACCEPTANCE_LABEL, profile.dispatchLabel, ...profile.roles.flatMap(role => role.labels)];
      await deps.github.preflight(profile.repository, [...new Set(labels)]);
    } catch (error) {
      throw new Refused(`preflight failed: ${(error as Error).message}`);
    }

    const server: LaunchedServer = await deps.launcher.start(staged.spec, options.resume);
    let owner: OwnerSession | null = null;
    try {
      owner = await server.owner();
      const confirmed = await controller.confirmChannel({ channelId: owner.channelId, channelUrl: owner.channelUrl, humanUrl: server.humanUrl });
      if (!confirmed) throw new Refused('the human did not confirm the channel');

      for (const role of profile.roles) {
        const issue = await deps.github.createIssue({
          repository: profile.repository,
          title: ticketTitle(profile, role, markers),
          body: ticketPrompt({ profile, role, markers, plan, channelUrl: owner.channelUrl }),
          labels: [ACCEPTANCE_LABEL, profile.dispatchLabel, ...role.labels],
        });
        roles.push({ role: role.role, ticket: issue.number, session: null, target: null, granted: false });
        controller.note(`created #${issue.number} for role ${role.role.toUpperCase()}`);
      }

      await grantPair(deps, owner, profile, roles, waitFor);

      await waitFor('both binding announcements', async () => {
        const announced = announcedTargets(await owner!.timeline(), markers);
        for (const record of roles) {
          const target = announced.get(record.role);
          if (target === 'ambiguous') throw new Error(`two participants announced role ${record.role}`);
          record.target = target ?? null;
        }
        return roles.every(record => record.target) ? true : null;
      });

      for (const mode of plan.runnable) {
        const results = await Promise.all(roles.map(record => owner!.requestMode(record.target!, mode)));
        const unsupported = results.find((result): result is Extract<ModeRequest, { kind: 'unsupported' }> => result.kind === 'unsupported');
        modeResults.set(mode, unsupported ?? { kind: 'effective' });
        await owner.say(controllerLine.mode(markers, mode, unsupported ? 'unsupported' : 'effective'), `acc-${options.runId}-mode-${mode}`);
        if (unsupported) continue;
        const final = `${markers.ack(mode)} ${markers.handshake('b', mode)}`;
        await waitFor(`the ${mode} handshake`, async () => ((await owner!.timeline()).some(event => event.body === final) ? true : null));
      }
      await owner.say(controllerLine.hold(markers), `acc-${options.runId}-hold`);
      stop = await guardedStop(deps, owner, server, roles, markers);
    } catch (error) {
      if (error instanceof Refused) refused = error.message;
      errors.push((error as Error).message);
    } finally {
      // A timeout or failure before Stop still stops whatever was bound.
      if (owner && !stop && roles.some(record => record.target)) {
        try { stop = await guardedStop(deps, owner, server, roles, markers); } catch (error) { errors.push(`stop: ${(error as Error).message}`); }
      }
      if (owner) {
        try { timeline = await owner.timeline(); } catch (error) { errors.push(`timeline: ${(error as Error).message}`); }
      }
      try {
        await server.close();
        launcherClosed = !(await server.reachable());
      } catch (error) {
        errors.push(`launcher close: ${(error as Error).message}`);
      }
    }

    if (launcherClosed) {
      try { snapshot = await deps.snapshot.read(server.channelId); } catch (error) { errors.push(`snapshot: ${(error as Error).message}`); }
    }
    for (const record of roles) {
      try {
        issues.push(await deps.github.getIssue(profile.repository, record.ticket));
        pullRequests.push(...await deps.github.linkedPullRequests(profile.repository, record.ticket));
      } catch (error) {
        errors.push(`github #${record.ticket}: ${(error as Error).message}`);
      }
    }
    pullRequests = [...new Set(pullRequests)];
  } catch (error) {
    if (error instanceof Refused) refused = error.message;
    errors.push((error as Error).message);
  } finally {
    try {
      await closeTickets(deps, profile, markers, roles, startedAt, cleanup);
      await staged?.release().catch((error: Error) => { errors.push(`package release: ${error.message}`); });
    } finally {
      await lock.release();
    }
  }

  if (refused !== null && roles.length === 0) return report('refused', []);
  const { checks } = verifyRun({
    profile, plan, markers, roles, issues, pullRequests, timeline, snapshot, stop, launcherClosed, modeResults,
  });
  const verdict = verdictOf(checks);
  // A run that errored or timed out failed, whatever its recorded checks say.
  return report(errors.length > 0 ? 'fail' : verdict, checks);
}

async function grantPair(
  deps: RunnerDeps,
  owner: OwnerSession,
  profile: Profile,
  roles: MutableRole[],
  waitFor: <T>(what: string, probe: () => Promise<T | null>) => Promise<T>,
): Promise<void> {
  const expected = (record: MutableRole): ProfileRole => profile.roles.find(role => role.role === record.role)!;
  await waitFor('both access grants', async () => {
    for (const record of roles) record.session ??= await deps.aiur.session(record.ticket);
    const pending = (await owner.accessRequests()).filter(request => request.outcome === 'pending_owner');
    for (const record of roles.filter(entry => !entry.granted)) {
      const role = expected(record);
      const candidates = pending.filter(request => request.harness === role.harness);
      let request: AccessRequest | undefined;
      let verified = false;
      if (record.session) {
        // The request is tied to the ticket through the Executor's own session record.
        request = candidates.find(entry => entry.sessionFingerprint === sessionDigest(role.harness, record.session!.sessionId));
        verified = request !== undefined;
      } else if (candidates.length === 1 && !roles.some(other => other !== record && expected(other).harness === role.harness)) {
        // No durable identity yet: the human may still grant, and the verdict stays unproven.
        request = candidates[0];
      }
      if (!request) continue;
      const confirmed = await deps.controller.confirmGrant({
        ticket: record.ticket, role: record.role, harness: role.harness, sessionFingerprint: request.sessionFingerprint, verified,
      });
      if (!confirmed) throw new Refused(`the human declined the grant for role ${record.role}`);
      await owner.approve(request, `acc-grant-${record.ticket}`);
      record.granted = true;
    }
    return roles.every(record => record.granted) ? true : null;
  });
}

async function guardedStop(
  deps: RunnerDeps,
  owner: OwnerSession,
  server: LaunchedServer,
  roles: readonly MutableRole[],
  markers: Markers,
): Promise<StopRecord> {
  const sessions = roles.map(record => record.session);
  const alive = async () => Promise.all(sessions.map(async (session, index) => {
    if (!session || !(await deps.aiur.alive(session))) return false;
    // Same identity: the Executor still records this exact session for the ticket.
    const current = await deps.aiur.session(roles[index]!.ticket);
    return current !== null && current.sessionId === session.sessionId && current.pid === session.pid;
  }));
  const aliveBefore = await alive();
  const targets = roles.map(record => record.target);
  const base = { aliveBefore, aliveAfter: [] as boolean[], serverViewableAfter: null as boolean | null };
  if (targets.some(target => target === null)) {
    return { ...base, attempted: false, reply: null, at: null, refusedLocally: 'a role has no recorded binding' };
  }
  // Refuse a stale or mismatched target before the server is asked: the latest
  // server-attributed announcement must still name exactly the recorded binding.
  const latest = announcedTargets(await owner.timeline(), markers);
  const stale = roles.find(record => {
    const current = latest.get(record.role);
    return !current || current === 'ambiguous' || !sameTarget(current, record.target!);
  });
  if (stale) {
    return { ...base, attempted: false, reply: null, at: null, refusedLocally: `the recorded binding for role ${stale.role} is stale or mismatched` };
  }
  // Any delivery evidence for a stopped binding observed after the request fails the run.
  const at = new Date(deps.clock.now()).toISOString();
  const reply = await owner.stop(targets as StopTarget[]);
  const aliveAfter = await alive();
  const serverViewableAfter = (await server.reachable()) && (await owner.viewable());
  return { attempted: true, reply, at, refusedLocally: null, aliveBefore, aliveAfter, serverViewableAfter };
}

/** Closes only issues this run created: same repository, label, marker line and creation window. */
async function closeTickets(
  deps: RunnerDeps,
  profile: Profile,
  markers: Markers,
  roles: readonly MutableRole[],
  startedAt: string,
  outcomes: RunReport['cleanup'][number][],
): Promise<void> {
  for (const record of roles) {
    try {
      const issue = await deps.github.getIssue(profile.repository, record.ticket);
      const owned = issue.repository === profile.repository
        && issue.labels.includes(ACCEPTANCE_LABEL)
        && issue.body.startsWith(ownershipLine(markers, record.role, profile))
        && Date.parse(issue.createdAt) >= Date.parse(startedAt) - 60_000;
      if (!owned) {
        outcomes.push({ ticket: record.ticket, outcome: 'refused', detail: 'issue is not owned by this run' });
      } else if (issue.state === 'closed') {
        outcomes.push({ ticket: record.ticket, outcome: 'already_closed', detail: 'already closed' });
      } else {
        await deps.github.closeIssue(profile.repository, record.ticket, `Closed by the live acceptance runner (${markers.run}).`);
        outcomes.push({ ticket: record.ticket, outcome: 'closed', detail: 'closed' });
      }
    } catch (error) {
      outcomes.push({ ticket: record.ticket, outcome: 'failed', detail: (error as Error).message });
    }
  }
}
