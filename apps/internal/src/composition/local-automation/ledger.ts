import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ListeningModeView, SessionBinding } from '@khala/contracts/delivery/index';
import type { StoredEvent } from '../../store/channel-store';
import { internalReleaseId } from '../../store/release-id';
import type { InternalStoreHandle } from '../../store/open';
import { bindingPauseRecordKey } from '../../store/pause-store';
import { evaluateAdmittedPeer, type AdmittedPeerDecision } from './admitted-peer';
import type { LocalAutomationProvider } from './provider';

export type LocalReservation =
  | Readonly<{ kind: 'reserved' | 'duplicate'; releaseId: string; rootId: string; depth: number; modeVersion: number;
    state: 'reserved' | 'finished' }>
  | Extract<AdmittedPeerDecision, { kind: 'held' }>;

type PeerEvent = Pick<StoredEvent, 'eventId' | 'channelId' | 'authorParticipantId' | 'authorDeviceId'>
  & Readonly<{ participant: Pick<StoredEvent['participant'], 'kind'> }>;

export type LocalAutomationLedger = Readonly<{
  reserve(input: Readonly<{ recipient: SessionBinding; event: PeerEvent; mode: ListeningModeView | null;
    claimedIdleEpoch?: string | null }>): LocalReservation;
  /** Earliest still-eligible arrival for a sleeping bound recipient; no content read. */
  nextPending(input: Readonly<{ recipient: SessionBinding; channelId: string; mode: ListeningModeView | null;
    claimedIdleEpoch?: string | null }>): LocalReservation | null;
  /** Called only after the provider's exact-session terminal boundary was verified. */
  finishEnded(input: Readonly<{ recipient: SessionBinding; channelId: string; epoch: string;
    batchToken?: string | null }>): number;
  issueClaudeChallenge(input: Readonly<{ recipient: SessionBinding; channelId: string;
    batchToken: string }>): Readonly<{ nonce: string; bindingId: string; generation: number; channelId: string }> | null;
  completeClaudeChallenge(input: Readonly<{ recipient: SessionBinding; channelId: string;
    nativeSessionId: string; batchToken: string; terminalId: string; nonce: string; proof: string }>): boolean;
}>;

const TERMINAL_CHALLENGE_MS = 2 * 60_000;
const terminalDigest = (token: string) => createHash('sha256').update(token).digest('hex');
const terminalEpoch = (terminalId: string) => {
  const hash = createHash('sha256').update('khala-local-terminal-v1\0').update(terminalId).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
};
const claudeTerminalId = (binding: SessionBinding, token: string) => createHash('sha256').update(JSON.stringify([
  'khala.claude.turn-end.v1', binding.bindingId, binding.generation, token,
])).digest('base64url');

function proofMessage(nonce: string, recipient: SessionBinding, channelId: string, nativeSessionId: string): string {
  return JSON.stringify(['khala.claude.terminal.v1', nonce, nativeSessionId,
    recipient.bindingId, recipient.generation, channelId]);
}

type BindingRow = Readonly<{
  binding_id: string; generation: number; owner_id: string; participant_id: string;
  device_id: string; harness: string; session_id: string; status: string;
}>;

function activeBinding(db: DatabaseSync, binding: SessionBinding, channelId: string): boolean {
  const row = db.prepare(`SELECT b.*, member.membership FROM bindings b
    JOIN memberships member ON member.participant_id = b.participant_id AND member.channel_id = ?
    JOIN discovery_activations admission ON admission.binding_id = b.binding_id
      AND admission.generation = b.generation AND admission.channel_id = member.channel_id
    WHERE b.binding_id = ? AND b.generation = ? AND b.generation =
      (SELECT max(newer.generation) FROM bindings newer WHERE newer.binding_id = b.binding_id)`)
    .get(channelId, binding.bindingId, binding.generation) as (BindingRow & { membership: string }) | undefined;
  return row?.status === 'active' && row.membership === 'joined'
    && row.owner_id === binding.ownerId && row.participant_id === binding.agentParticipantId
    && row.device_id === binding.deviceId && row.harness === binding.harness && row.session_id === binding.sessionId;
}

function senderBinding(db: DatabaseSync, event: PeerEvent): SessionBinding | null {
  const author = db.prepare(`SELECT author_binding_id AS binding_id,
    author_binding_generation AS generation FROM events WHERE event_id = ? AND channel_id = ?`)
    .get(event.eventId, event.channelId) as { binding_id: string | null; generation: number | null } | undefined;
  if (!author?.binding_id || author.generation === null) return null;
  const rows = db.prepare(`SELECT b.* FROM bindings b
    JOIN memberships member ON member.participant_id = b.participant_id AND member.channel_id = ?
    JOIN discovery_activations admission ON admission.binding_id = b.binding_id
      AND admission.generation = b.generation AND admission.channel_id = member.channel_id
    WHERE b.binding_id = ? AND b.generation = ? AND b.participant_id = ? AND b.device_id = ?
      AND b.status = 'active' AND member.membership = 'joined'
      AND b.generation = (SELECT max(newer.generation) FROM bindings newer WHERE newer.binding_id = b.binding_id)`)
    .all(event.channelId, author.binding_id, author.generation,
      event.authorParticipantId, event.authorDeviceId) as unknown as BindingRow[];
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return { v: 1, bindingId: row.binding_id as SessionBinding['bindingId'], generation: row.generation,
    ownerId: row.owner_id as SessionBinding['ownerId'], agentParticipantId: row.participant_id as SessionBinding['agentParticipantId'],
    deviceId: row.device_id as SessionBinding['deviceId'], harness: row.harness, sessionId: row.session_id };
}

function paused(db: DatabaseSync, binding: SessionBinding): boolean | 'unavailable' {
  const row = db.prepare('SELECT value FROM control_records WHERE record_key = ?')
    .get(bindingPauseRecordKey(binding)) as { value: string } | undefined;
  if (!row) return false;
  try {
    const value: unknown = JSON.parse(row.value);
    return typeof value === 'object' && value !== null && typeof (value as { paused?: unknown }).paused === 'boolean'
      ? (value as { paused: boolean }).paused : 'unavailable';
  } catch { return 'unavailable'; }
}

/** Same SQLite transaction checks grant, mode revision, pause and shared causal counters before reserving. */
export function createLocalAutomationLedger(
  handle: InternalStoreHandle, provider: LocalAutomationProvider, claudeTerminalKey?: Uint8Array,
): LocalAutomationLedger {
  const terminalKey = claudeTerminalKey?.length === 32 ? Buffer.from(claudeTerminalKey) : null;
  const ledger: LocalAutomationLedger = {
    reserve({ recipient, event, mode, claimedIdleEpoch }) {
      try {
        return handle.transaction(db => {
          const releaseId = internalReleaseId(recipient, event.eventId);
          const existing = db.prepare(`SELECT root_id, depth, mode_version, state FROM automation_releases
            WHERE release_id = ? AND event_id = ? AND binding_id = ? AND generation = ?`)
            .get(releaseId, event.eventId, recipient.bindingId, recipient.generation) as {
              root_id: string; depth: number; mode_version: number; state: 'reserved' | 'finished';
            } | undefined;
          const source = db.prepare(`SELECT causal_root_id AS root_id, causal_depth AS depth FROM events
            WHERE event_id = ? AND channel_id = ? AND author_participant_id = ? AND author_device_id = ?`)
            .get(event.eventId, event.channelId, event.authorParticipantId, event.authorDeviceId) as {
              root_id: string | null; depth: number | null;
            } | undefined;
          const arrival = db.prepare(`SELECT mode_version FROM automation_arrivals
            WHERE event_id = ? AND binding_id = ? AND generation = ?`)
            .get(event.eventId, recipient.bindingId, recipient.generation) as { mode_version: number } | undefined;
          const current = db.prepare('SELECT version FROM mode_controls WHERE binding_id = ? AND generation = ?')
            .get(recipient.bindingId, recipient.generation) as { version: number } | undefined;
          const released = source?.root_id ? (db.prepare('SELECT count(*) AS count FROM automation_releases WHERE root_id = ?')
            .get(source.root_id) as { count: number }).count : 0;
          const active = (db.prepare(`SELECT count(*) AS count FROM automation_releases ar
            JOIN events e ON e.event_id = ar.event_id
            JOIN bindings b ON b.binding_id = ar.binding_id AND b.generation = ar.generation
            JOIN memberships member ON member.channel_id = e.channel_id AND member.participant_id = b.participant_id
            WHERE e.channel_id = ? AND ar.state = 'reserved' AND b.status = 'active'
              AND member.membership = 'joined'
              AND b.generation = (SELECT max(newer.generation) FROM bindings newer WHERE newer.binding_id = b.binding_id)`)
            .get(event.channelId) as { count: number }).count;
          const sender = event.participant.kind === 'agent' ? senderBinding(db, event) : null;
          const decision = evaluateAdmittedPeer(provider, {
            recipient, sender,
            recipientChannelId: event.channelId, senderChannelId: event.channelId,
            recipientActive: activeBinding(db, recipient, event.channelId), senderActive: sender !== null,
            paused: paused(db, recipient), mode: current?.version === mode?.version ? mode : null,
            arrivedModeVersion: arrival?.mode_version ?? null,
            causal: source?.root_id !== null && source?.root_id !== undefined && source.depth !== null
              ? { rootId: source.root_id, depth: source.depth } : null,
            releasedInCausalRoot: released - (existing ? 1 : 0),
            activeJobs: active - (existing?.state === 'reserved' ? 1 : 0),
          });
          if (decision.kind === 'held') return decision;
          if (existing) {
            return { kind: 'duplicate', releaseId, rootId: existing.root_id, depth: existing.depth,
              modeVersion: existing.mode_version, state: existing.state } as const;
          }
          db.prepare(`INSERT INTO automation_releases
            (release_id, event_id, binding_id, generation, root_id, depth, mode_version, claimed_idle_epoch, state)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`)
            .run(releaseId, event.eventId, recipient.bindingId, recipient.generation,
              decision.rootId, decision.depth, decision.modeVersion, claimedIdleEpoch ?? null);
          return { kind: 'reserved', releaseId, rootId: decision.rootId, depth: decision.depth,
            modeVersion: decision.modeVersion, state: 'reserved' } as const;
        });
      } catch { return { kind: 'held', reason: 'causal_unknown' }; }
    },
    nextPending({ recipient, channelId, mode, claimedIdleEpoch }) {
      if (!mode || mode.effective !== 'steer' && mode.effective !== 'sync') return null;
      try {
        const row = handle.read(db => db.prepare(`SELECT e.event_id, e.channel_id,
          e.author_participant_id, e.author_device_id FROM automation_arrivals arrival
          JOIN events e ON e.event_id = arrival.event_id
          JOIN participants p ON p.participant_id = e.author_participant_id
          JOIN mode_controls control ON control.binding_id = arrival.binding_id
            AND control.generation = arrival.generation AND control.version = arrival.mode_version
          JOIN bindings sender ON sender.binding_id = e.author_binding_id
            AND sender.generation = e.author_binding_generation
            AND sender.participant_id = e.author_participant_id
            AND sender.device_id = e.author_device_id AND sender.status = 'active'
          JOIN discovery_activations admission ON admission.binding_id = sender.binding_id
            AND admission.generation = sender.generation AND admission.channel_id = e.channel_id
          JOIN memberships member ON member.channel_id = e.channel_id
            AND member.participant_id = sender.participant_id AND member.membership = 'joined'
          LEFT JOIN automation_releases reserved ON reserved.event_id = e.event_id
            AND reserved.binding_id = arrival.binding_id AND reserved.generation = arrival.generation
          WHERE arrival.binding_id = ? AND arrival.generation = ? AND e.channel_id = ?
            AND p.kind = 'agent' AND e.author_participant_id <> ?
            AND e.causal_root_id IS NOT NULL AND e.causal_depth < ?
            AND sender.generation = (SELECT max(newer.generation) FROM bindings newer
              WHERE newer.binding_id = sender.binding_id)
            AND (reserved.release_id IS NOT NULL OR (SELECT count(*) FROM automation_releases budget
              WHERE budget.root_id = e.causal_root_id) < ?)
            AND (reserved.state IS NULL OR reserved.state = 'reserved')
          ORDER BY e.sequence LIMIT 1`).get(recipient.bindingId, recipient.generation, channelId,
          recipient.agentParticipantId, provider.limits.maxCausalDepth,
          provider.limits.maxJobsPerCausalRoot) as {
            event_id: string; channel_id: string; author_participant_id: string; author_device_id: string;
          } | undefined);
        if (!row) return null;
        return ledger.reserve({ recipient, event: { eventId: row.event_id as StoredEvent['eventId'],
          channelId: row.channel_id as StoredEvent['channelId'],
          authorParticipantId: row.author_participant_id as StoredEvent['authorParticipantId'],
          authorDeviceId: row.author_device_id as StoredEvent['authorDeviceId'], participant: { kind: 'agent' } },
        mode, ...(claimedIdleEpoch === undefined ? {} : { claimedIdleEpoch }) });
      } catch { return null; }
    },
    finishEnded({ recipient, channelId, epoch, batchToken }) {
      try {
        return handle.transaction(db => {
          if (!activeBinding(db, recipient, channelId) || !/^[0-9a-f-]{36}$/u.test(epoch)) return 0;
          const unused = db.prepare(`INSERT INTO automation_turn_ends (binding_id, generation, epoch)
            VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).run(recipient.bindingId, recipient.generation, epoch);
          if (unused.changes !== 1) return 0;
          // The exact release must belong to a server-issued inbox batch. A
          // transport pull alone is not a model offer and cannot complete a job.
          const changed = db.prepare(`UPDATE automation_releases SET state = 'finished'
            WHERE binding_id = ? AND generation = ? AND state = 'reserved'
              AND (claimed_idle_epoch IS NULL OR claimed_idle_epoch <> ?)
              AND EXISTS (SELECT 1 FROM issued_agent_batch_members issued
                JOIN events e ON e.event_id = automation_releases.event_id
                WHERE issued.release_id = automation_releases.release_id
                  AND issued.binding_id = automation_releases.binding_id
                  AND issued.generation = automation_releases.generation
                  AND issued.channel_id = ? AND e.channel_id = ?
                  AND (? IS NULL OR issued.token = ?))`)
            .run(recipient.bindingId, recipient.generation, epoch, channelId, channelId,
              batchToken ?? null, batchToken ?? null);
          return Number(changed.changes);
        });
      } catch { return 0; }
    },
    issueClaudeChallenge({ recipient, channelId, batchToken }) {
      if (terminalKey === null || recipient.harness !== 'claude' || !batchToken) return null;
      try {
        return handle.transaction(db => {
          if (!activeBinding(db, recipient, channelId)) return null;
          const jobs = db.prepare(`SELECT ar.release_id FROM automation_releases ar
            JOIN events event ON event.event_id = ar.event_id
            JOIN issued_agent_batch_members issued ON issued.release_id = ar.release_id
              AND issued.binding_id = ar.binding_id AND issued.generation = ar.generation
            WHERE ar.binding_id = ? AND ar.generation = ? AND ar.state = 'reserved'
              AND event.channel_id = ? AND issued.channel_id = ? AND issued.token = ?`)
            .all(recipient.bindingId, recipient.generation, channelId, channelId, batchToken) as unknown as { release_id: string }[];
          if (jobs.length !== 1) return null;
          const nonce = randomBytes(24).toString('base64url');
          // One live challenge per current job; old replies remain harmless and
          // completed jobs do not accumulate challenge rows indefinitely.
          db.prepare(`DELETE FROM automation_terminal_challenges
            WHERE used = 1 OR expires_at < ? OR release_id = ?`)
            .run(Date.now(), jobs[0]!.release_id);
          db.prepare(`INSERT INTO automation_terminal_challenges
            (nonce, binding_id, generation, channel_id, release_id, token_digest, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(nonce, recipient.bindingId, recipient.generation, channelId, jobs[0]!.release_id,
              terminalDigest(batchToken), Date.now() + TERMINAL_CHALLENGE_MS);
          return { nonce, bindingId: recipient.bindingId, generation: recipient.generation, channelId };
        });
      } catch { return null; }
    },
    completeClaudeChallenge({ recipient, channelId, nativeSessionId, batchToken, terminalId, nonce, proof }) {
      if (terminalKey === null || recipient.harness !== 'claude' || !batchToken
        || terminalId !== claudeTerminalId(recipient, batchToken)
        || !/^[A-Za-z0-9_-]{32}$/u.test(nonce) || !/^[A-Za-z0-9_-]{43}$/u.test(proof)) return false;
      const expected = createHmac('sha256', terminalKey)
        .update(proofMessage(nonce, recipient, channelId, nativeSessionId)).digest();
      const presented = Buffer.from(proof, 'base64url');
      if (presented.length !== expected.length || presented.toString('base64url') !== proof
        || !timingSafeEqual(expected, presented)) return false;
      try {
        return handle.transaction(db => {
          if (!activeBinding(db, recipient, channelId)) return false;
          const challenge = db.prepare(`SELECT release_id, token_digest, expires_at, used
            FROM automation_terminal_challenges WHERE nonce = ? AND binding_id = ?
              AND generation = ? AND channel_id = ?`)
            .get(nonce, recipient.bindingId, recipient.generation, channelId) as {
              release_id: string; token_digest: string; expires_at: number; used: number;
            } | undefined;
          if (!challenge || challenge.used !== 0 || challenge.expires_at < Date.now()
            || challenge.token_digest !== terminalDigest(batchToken)) return false;
          const epoch = terminalEpoch(terminalId);
          const end = db.prepare(`INSERT INTO automation_turn_ends (binding_id, generation, epoch)
            VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).run(recipient.bindingId, recipient.generation, epoch);
          if (end.changes !== 1) return false;
          const finished = db.prepare(`UPDATE automation_releases SET state = 'finished'
            WHERE release_id = ? AND binding_id = ? AND generation = ? AND state = 'reserved'
              AND (claimed_idle_epoch IS NULL OR claimed_idle_epoch <> ?)
              AND EXISTS (SELECT 1 FROM issued_agent_batch_members issued
                JOIN events event ON event.event_id = automation_releases.event_id
                WHERE issued.release_id = automation_releases.release_id
                  AND issued.binding_id = automation_releases.binding_id
                  AND issued.generation = automation_releases.generation
                  AND issued.channel_id = ? AND issued.token = ? AND event.channel_id = ?)`)
            .run(challenge.release_id, recipient.bindingId, recipient.generation,
              epoch, channelId, batchToken, channelId);
          if (finished.changes !== 1) {
            // Roll back the epoch insert with the rest of this attempt. A later
            // current challenge can reconcile a lost or raced terminal reply.
            throw new Error('terminal_job_not_current');
          }
          db.prepare('UPDATE automation_terminal_challenges SET used = 1 WHERE nonce = ?').run(nonce);
          return true;
        });
      } catch { return false; }
    },
  };
  return ledger;
}
