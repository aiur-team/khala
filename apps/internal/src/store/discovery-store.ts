import { type SessionBinding, sameSessionBinding } from '@khala/contracts/delivery/index';
import type { DeviceId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import type { InternalStoreHandle } from './open';

// Durable internal channel discovery. Visibility defaults to `private` with an
// empty allowlist, so an unconfigured channel is listed to nobody. Discovery
// agents are stored by capability digest only; reissuing for the same harness
// session rotates that digest and increments the generation. Admission and the
// create adapter are idempotent per operation and never create a binding; only
// activation of an exchanged operation does, once per operation.

export type DiscoveryVisibility = 'public' | 'private' | 'secret';

export type DiscoveryAgent = Readonly<{
  principal: string;
  harness: string;
  sessionDigest: string;
  displayLabel: string | null;
  workspaceLabel: string | null;
  generation: number;
  proofPublicKey: string;
  proofThumbprint: string;
  issuedAt: string;
}>;

export type ChannelDiscoverySettings = Readonly<{
  channelId: string;
  visibility: DiscoveryVisibility;
  /** Changes only when visibility changes; pending requests bind to it. */
  visibilityEpoch: number;
  /** Changes on every settings write; owner mutations compare against it. */
  revision: number;
  allowlist: readonly string[];
}>;

export type DiscoveryTarget = Readonly<{
  channelId: string;
  title: string | null;
  visibility: DiscoveryVisibility;
  visibilityEpoch: number;
}>;

export type SettingsChange =
  | Readonly<{ kind: 'visibility'; visibility: DiscoveryVisibility }>
  | Readonly<{ kind: 'allow' | 'revoke'; principal: string; expectedGeneration: number }>;

export type SettingsRejection = 'not_found' | 'stale_revision' | 'operation_mismatch' | 'unknown_principal' | 'wrong_generation';

export type AdmissionInput = Readonly<{
  providerOperationId: string;
  channelId: string;
  ownerId: OwnerId;
  participantId: ParticipantId;
  deviceId: DeviceId;
  displayName: string;
}>;

export type AdmissionOutcome =
  | Readonly<{ kind: 'admitted'; membership: 'joined' | 'already_joined' }>
  | Readonly<{ kind: 'rejected' }>
  | Readonly<{ kind: 'unavailable' }>;

export type SecretChannelInput = Readonly<{
  idempotencyKey: string;
  channelId: string;
  title: string;
  ownerId: OwnerId;
  creatorParticipantId: ParticipantId;
  creatorDeviceId: DeviceId;
  createdAt: string;
}>;

export type SecretChannelOutcome =
  | Readonly<{ kind: 'created' | 'already_created'; channelId: RoomId }>
  | Readonly<{ kind: 'operation_mismatch' }>
  | Readonly<{ kind: 'unavailable' }>;

/** One exchanged operation's binding, keyed by a requester/origin/operation digest. */
export type ActivationInput = Readonly<{
  operationKey: string;
  binding: SessionBinding;
  channelId: string;
  sessionGeneration: number;
}>;

export type StoredActivation = Readonly<{
  binding: SessionBinding;
  channelId: RoomId;
  sessionGeneration: number;
  status: 'active' | 'revoked';
}>;

type Unavailable = Readonly<{ kind: 'unavailable' }>;

export interface DiscoveryStore {
  /** Inserts a new principal at generation 1, or rotates an existing one to the next generation. */
  issueAgent(input: Omit<DiscoveryAgent, 'generation'> & Readonly<{ capabilityDigest: string }>):
    Readonly<{ kind: 'issued'; agent: DiscoveryAgent }> | Readonly<{ kind: 'rejected' }> | Unavailable;
  agentByCapability(capabilityDigest: string): Readonly<{ kind: 'found'; agent: DiscoveryAgent }> | Readonly<{ kind: 'absent' }> | Unavailable;
  agent(principal: string): Readonly<{ kind: 'found'; agent: DiscoveryAgent }> | Readonly<{ kind: 'absent' }> | Unavailable;
  listAgents(): Readonly<{ kind: 'done'; agents: readonly DiscoveryAgent[] }> | Unavailable;
  settings(channelId: string): Readonly<{ kind: 'done'; settings: ChannelDiscoverySettings }> | Readonly<{ kind: 'not_found' }> | Unavailable;
  updateSettings(input: Readonly<{
    channelId: string;
    operationId: string;
    expectedRevision: number;
    change: SettingsChange;
  }>): Readonly<{ kind: 'done'; settings: ChannelDiscoverySettings }> | Readonly<{ kind: 'rejected'; code: SettingsRejection }> | Unavailable;
  /** Channels this principal may enumerate, in stable title order. Secret channels never appear. */
  eligibleChannels(principal: string): Readonly<{ kind: 'done'; channels: readonly DiscoveryTarget[] }> | Unavailable;
  target(channelId: string): Readonly<{ kind: 'found'; target: DiscoveryTarget }> | Readonly<{ kind: 'absent' }> | Unavailable;
  eligible(channelId: string, principal: string): boolean | 'unavailable';
  admit(input: AdmissionInput): AdmissionOutcome;
  /** `not_applied` is proof: admission and its operation record commit together. */
  reconcileAdmission(input: AdmissionInput): AdmissionOutcome | Readonly<{ kind: 'not_applied' }>;
  createSecretChannel(input: SecretChannelInput): SecretChannelOutcome;
  findSecretChannel(idempotencyKey: string): SecretChannelOutcome | Readonly<{ kind: 'absent' }>;
  /**
   * Registers the binding for a joined agent and records it against the operation, in
   * one transaction. The same operation returns the stored activation; different input
   * for it, a missing membership or a foreign device is rejected.
   */
  activate(input: ActivationInput): Readonly<{ kind: 'activated'; activation: StoredActivation }> | Readonly<{ kind: 'rejected' }> | Unavailable;
  activation(operationKey: string): Readonly<{ kind: 'found'; activation: StoredActivation }> | Readonly<{ kind: 'absent' }> | Unavailable;
}

type ActivationRow = Readonly<{
  binding_id: string;
  generation: number;
  owner_id: string;
  participant_id: string;
  device_id: string;
  harness: string;
  session_id: string;
  status: 'active' | 'revoked';
  channel_id: string;
  session_generation: number;
}>;

const ACTIVATION_SELECT = `
  SELECT b.binding_id, b.generation, b.owner_id, b.participant_id, b.device_id, b.harness, b.session_id, b.status,
    a.channel_id, a.session_generation
  FROM discovery_activations a JOIN bindings b ON b.binding_id = a.binding_id AND b.generation = a.generation
  WHERE a.operation_key = ?
`;

function activationFromRow(row: ActivationRow): StoredActivation {
  return {
    binding: {
      v: 1,
      bindingId: row.binding_id as SessionBinding['bindingId'],
      ownerId: row.owner_id as OwnerId,
      agentParticipantId: row.participant_id as ParticipantId,
      deviceId: row.device_id as DeviceId,
      harness: row.harness,
      sessionId: row.session_id,
      generation: row.generation,
    },
    channelId: row.channel_id as RoomId,
    sessionGeneration: row.session_generation,
    status: row.status,
  };
}

type AgentRow = Readonly<{
  principal: string;
  harness: string;
  session_digest: string;
  display_label: string | null;
  workspace_label: string | null;
  generation: number;
  capability_digest: string;
  proof_public_key: string;
  proof_thumbprint: string;
  issued_at: string;
}>;

type TargetRow = Readonly<{
  channel_id: string;
  title: string | null;
  visibility: DiscoveryVisibility | null;
  visibility_epoch: number | null;
}>;

const CREATE_OPERATION_PREFIX = 'discovery-create:';
const VISIBILITIES: readonly DiscoveryVisibility[] = ['public', 'private', 'secret'];

const unavailable = (): Unavailable => ({ kind: 'unavailable' });

function agentFromRow(row: AgentRow): DiscoveryAgent {
  return {
    principal: row.principal,
    harness: row.harness,
    sessionDigest: row.session_digest,
    displayLabel: row.display_label,
    workspaceLabel: row.workspace_label,
    generation: row.generation,
    proofPublicKey: row.proof_public_key,
    proofThumbprint: row.proof_thumbprint,
    issuedAt: row.issued_at,
  };
}

function targetFromRow(row: TargetRow): DiscoveryTarget {
  return {
    channelId: row.channel_id,
    title: row.title,
    visibility: row.visibility ?? 'private',
    visibilityEpoch: row.visibility_epoch ?? 0,
  };
}

const TARGET_SELECT = `
  SELECT c.channel_id, c.title, v.visibility, v.visibility_epoch
  FROM channels c LEFT JOIN discovery_visibility v ON v.channel_id = c.channel_id
`;

export function createDiscoveryStore(handle: InternalStoreHandle): DiscoveryStore {
  type Db = Parameters<Parameters<InternalStoreHandle['read']>[0]>[0];

  function readSettings(db: Db, channelId: string): ChannelDiscoverySettings | null {
    if (!db.prepare('SELECT 1 FROM channels WHERE channel_id = ?').get(channelId)) return null;
    const row = db.prepare('SELECT visibility, visibility_epoch, revision FROM discovery_visibility WHERE channel_id = ?')
      .get(channelId) as { visibility: DiscoveryVisibility; visibility_epoch: number; revision: number } | undefined;
    const allowlist = (db.prepare('SELECT principal FROM discovery_allowlist WHERE channel_id = ? ORDER BY principal')
      .all(channelId) as unknown as Array<{ principal: string }>).map(entry => entry.principal);
    return {
      channelId,
      visibility: row?.visibility ?? 'private',
      visibilityEpoch: row?.visibility_epoch ?? 0,
      revision: row?.revision ?? 0,
      allowlist,
    };
  }

  function admissionFingerprint(input: AdmissionInput): string {
    return JSON.stringify(['khala.discovery.admit.v1', input.channelId, input.ownerId, input.participantId, input.deviceId]);
  }

  const store: DiscoveryStore = {
    issueAgent(input) {
      if (![input.principal, input.harness, input.sessionDigest, input.capabilityDigest, input.proofPublicKey,
        input.proofThumbprint, input.issuedAt].every(value => typeof value === 'string' && value.length > 0)) {
        return { kind: 'rejected' };
      }
      try {
        return handle.transaction(db => {
          const existing = db.prepare('SELECT * FROM discovery_agents WHERE principal = ?').get(input.principal) as AgentRow | undefined;
          if (existing && (existing.harness !== input.harness || existing.session_digest !== input.sessionDigest)) {
            return { kind: 'rejected' } as const;
          }
          const generation = (existing?.generation ?? 0) + 1;
          db.prepare(`
            INSERT INTO discovery_agents (
              principal, harness, session_digest, display_label, workspace_label, generation,
              capability_digest, proof_public_key, proof_thumbprint, issued_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (principal) DO UPDATE SET
              display_label = excluded.display_label, workspace_label = excluded.workspace_label,
              generation = excluded.generation, capability_digest = excluded.capability_digest,
              proof_public_key = excluded.proof_public_key, proof_thumbprint = excluded.proof_thumbprint,
              issued_at = excluded.issued_at
          `).run(
            input.principal, input.harness, input.sessionDigest, input.displayLabel, input.workspaceLabel, generation,
            input.capabilityDigest, input.proofPublicKey, input.proofThumbprint, input.issuedAt,
          );
          const row = db.prepare('SELECT * FROM discovery_agents WHERE principal = ?').get(input.principal) as AgentRow;
          return { kind: 'issued', agent: agentFromRow(row) } as const;
        });
      } catch { return unavailable(); }
    },

    agentByCapability(capabilityDigest) {
      try {
        const row = handle.read(db => db.prepare('SELECT * FROM discovery_agents WHERE capability_digest = ?')
          .get(capabilityDigest) as AgentRow | undefined);
        return row ? { kind: 'found', agent: agentFromRow(row) } : { kind: 'absent' };
      } catch { return unavailable(); }
    },

    agent(principal) {
      try {
        const row = handle.read(db => db.prepare('SELECT * FROM discovery_agents WHERE principal = ?')
          .get(principal) as AgentRow | undefined);
        return row ? { kind: 'found', agent: agentFromRow(row) } : { kind: 'absent' };
      } catch { return unavailable(); }
    },

    listAgents() {
      try {
        const rows = handle.read(db => db.prepare('SELECT * FROM discovery_agents ORDER BY issued_at, principal')
          .all() as unknown as AgentRow[]);
        return { kind: 'done', agents: rows.map(agentFromRow) };
      } catch { return unavailable(); }
    },

    settings(channelId) {
      try {
        const settings = handle.read(db => readSettings(db, channelId));
        return settings ? { kind: 'done', settings } : { kind: 'not_found' };
      } catch { return unavailable(); }
    },

    updateSettings(input) {
      const { change } = input;
      if (change.kind === 'visibility' && !VISIBILITIES.includes(change.visibility)) return { kind: 'rejected', code: 'not_found' };
      const fingerprint = JSON.stringify(['khala.discovery.settings.v1', input.channelId, input.expectedRevision, change]);
      try {
        return handle.transaction(db => {
          const operation = db.prepare('SELECT fingerprint, revision FROM discovery_operations WHERE operation_id = ?')
            .get(input.operationId) as { fingerprint: string; revision: number } | undefined;
          const current = readSettings(db, input.channelId);
          if (operation) {
            if (operation.fingerprint !== fingerprint || !current) return { kind: 'rejected', code: 'operation_mismatch' } as const;
            return { kind: 'done', settings: current } as const;
          }
          if (!current) return { kind: 'rejected', code: 'not_found' } as const;
          if (current.revision !== input.expectedRevision) return { kind: 'rejected', code: 'stale_revision' } as const;
          let visibility = current.visibility;
          let epoch = current.visibilityEpoch;
          if (change.kind === 'visibility') {
            if (change.visibility !== visibility) epoch += 1;
            visibility = change.visibility;
          } else {
            const agent = db.prepare('SELECT generation FROM discovery_agents WHERE principal = ?')
              .get(change.principal) as { generation: number } | undefined;
            if (!agent) return { kind: 'rejected', code: 'unknown_principal' } as const;
            if (change.kind === 'allow' && agent.generation !== change.expectedGeneration) {
              return { kind: 'rejected', code: 'wrong_generation' } as const;
            }
            if (change.kind === 'allow') {
              db.prepare('INSERT OR IGNORE INTO discovery_allowlist (channel_id, principal) VALUES (?, ?)')
                .run(input.channelId, change.principal);
            } else {
              db.prepare('DELETE FROM discovery_allowlist WHERE channel_id = ? AND principal = ?')
                .run(input.channelId, change.principal);
            }
          }
          const revision = current.revision + 1;
          db.prepare(`
            INSERT INTO discovery_visibility (channel_id, visibility, visibility_epoch, revision) VALUES (?, ?, ?, ?)
            ON CONFLICT (channel_id) DO UPDATE SET
              visibility = excluded.visibility, visibility_epoch = excluded.visibility_epoch, revision = excluded.revision
          `).run(input.channelId, visibility, epoch, revision);
          db.prepare('INSERT INTO discovery_operations (operation_id, fingerprint, revision) VALUES (?, ?, ?)')
            .run(input.operationId, fingerprint, revision);
          return { kind: 'done', settings: readSettings(db, input.channelId)! } as const;
        });
      } catch { return unavailable(); }
    },

    eligibleChannels(principal) {
      try {
        const rows = handle.read(db => db.prepare(`${TARGET_SELECT}
          WHERE v.visibility = 'public'
            OR (COALESCE(v.visibility, 'private') = 'private' AND EXISTS (
              SELECT 1 FROM discovery_allowlist a WHERE a.channel_id = c.channel_id AND a.principal = ?))
          ORDER BY COALESCE(c.title, ''), c.channel_id
        `).all(principal) as unknown as TargetRow[]);
        return { kind: 'done', channels: rows.map(targetFromRow) };
      } catch { return unavailable(); }
    },

    target(channelId) {
      try {
        const row = handle.read(db => db.prepare(`${TARGET_SELECT} WHERE c.channel_id = ?`).get(channelId) as TargetRow | undefined);
        return row ? { kind: 'found', target: targetFromRow(row) } : { kind: 'absent' };
      } catch { return unavailable(); }
    },

    eligible(channelId, principal) {
      try {
        return handle.read(db => {
          const row = db.prepare(`${TARGET_SELECT} WHERE c.channel_id = ?`).get(channelId) as TargetRow | undefined;
          if (!row) return false;
          const visibility = row.visibility ?? 'private';
          if (visibility === 'public') return true;
          if (visibility === 'secret') return false;
          return db.prepare('SELECT 1 FROM discovery_allowlist WHERE channel_id = ? AND principal = ?').get(channelId, principal) !== undefined;
        });
      } catch { return 'unavailable'; }
    },

    admit(input) {
      const fingerprint = admissionFingerprint(input);
      try {
        const result = handle.transaction(db => {
          const recorded = db.prepare('SELECT fingerprint, membership FROM admission_operations WHERE provider_operation_id = ?')
            .get(input.providerOperationId) as { fingerprint: string; membership: 'joined' | 'already_joined' } | undefined;
          if (recorded) {
            return recorded.fingerprint === fingerprint
              ? { kind: 'admitted', membership: recorded.membership } as const
              : { kind: 'rejected' } as const;
          }
          if (!db.prepare('SELECT 1 FROM channels WHERE channel_id = ?').get(input.channelId)) return { kind: 'rejected' } as const;
          const participant = db.prepare('SELECT owner_id, kind FROM participants WHERE participant_id = ?')
            .get(input.participantId) as { owner_id: string; kind: string } | undefined;
          if (participant && (participant.owner_id !== input.ownerId || participant.kind !== 'agent')) return { kind: 'rejected' } as const;
          if (!participant) {
            db.prepare("INSERT INTO participants (participant_id, owner_id, kind, display_name) VALUES (?, ?, 'agent', ?)")
              .run(input.participantId, input.ownerId, input.displayName);
          }
          const device = db.prepare('SELECT participant_id FROM devices WHERE device_id = ?')
            .get(input.deviceId) as { participant_id: string } | undefined;
          if (device && device.participant_id !== input.participantId) return { kind: 'rejected' } as const;
          if (!device) db.prepare('INSERT INTO devices (device_id, participant_id) VALUES (?, ?)').run(input.deviceId, input.participantId);
          const membership = db.prepare('SELECT membership FROM memberships WHERE channel_id = ? AND participant_id = ?')
            .get(input.channelId, input.participantId) as { membership: string } | undefined;
          const outcome = membership?.membership === 'joined' ? 'already_joined' : 'joined';
          if (outcome === 'joined') {
            db.prepare(`
              INSERT INTO memberships (channel_id, participant_id, membership) VALUES (?, ?, 'joined')
              ON CONFLICT (channel_id, participant_id) DO UPDATE SET membership = excluded.membership
            `).run(input.channelId, input.participantId);
            db.prepare('UPDATE channels SET revision = revision + 1 WHERE channel_id = ?').run(input.channelId);
          }
          db.prepare('INSERT INTO admission_operations (provider_operation_id, fingerprint, membership) VALUES (?, ?, ?)')
            .run(input.providerOperationId, fingerprint, outcome);
          return { kind: 'admitted', membership: outcome, changed: outcome === 'joined' } as const;
        });
        if (result.kind !== 'admitted') return result;
        if ('changed' in result && result.changed) handle.publish({ kind: 'channel', channelId: input.channelId });
        return { kind: 'admitted', membership: result.membership };
      } catch { return unavailable(); }
    },

    reconcileAdmission(input) {
      try {
        const recorded = handle.read(db => db.prepare('SELECT fingerprint, membership FROM admission_operations WHERE provider_operation_id = ?')
          .get(input.providerOperationId) as { fingerprint: string; membership: 'joined' | 'already_joined' } | undefined);
        if (!recorded) return { kind: 'not_applied' };
        return recorded.fingerprint === admissionFingerprint(input)
          ? { kind: 'admitted', membership: recorded.membership }
          : { kind: 'rejected' };
      } catch { return unavailable(); }
    },

    createSecretChannel(input) {
      const operationId = `${CREATE_OPERATION_PREFIX}${input.idempotencyKey}`;
      const fingerprint = JSON.stringify([
        'khala.discovery.create-secret.v1', input.ownerId, input.creatorParticipantId, input.creatorDeviceId, input.title,
      ]);
      try {
        const result = handle.transaction(db => {
          const operation = db.prepare('SELECT fingerprint, channel_id FROM channel_operations WHERE operation_id = ?')
            .get(operationId) as { fingerprint: string; channel_id: string } | undefined;
          if (operation) {
            return operation.fingerprint === fingerprint
              ? { kind: 'already_created', channelId: operation.channel_id as RoomId } as const
              : { kind: 'operation_mismatch' } as const;
          }
          if (db.prepare('SELECT 1 FROM channels WHERE channel_id = ?').get(input.channelId)) return { kind: 'operation_mismatch' } as const;
          const creator = db.prepare(`
            SELECT p.owner_id FROM devices d JOIN participants p ON p.participant_id = d.participant_id
            WHERE d.device_id = ? AND d.participant_id = ? AND p.kind = 'human'
          `).get(input.creatorDeviceId, input.creatorParticipantId) as { owner_id: string } | undefined;
          if (creator?.owner_id !== input.ownerId) return { kind: 'operation_mismatch' } as const;
          db.prepare(`
            INSERT INTO channels (channel_id, title, creator_participant_id, creator_device_id, revision, created_at)
            VALUES (?, ?, ?, ?, 0, ?)
          `).run(input.channelId, input.title, input.creatorParticipantId, input.creatorDeviceId, input.createdAt);
          db.prepare("INSERT INTO memberships (channel_id, participant_id, membership) VALUES (?, ?, 'joined')")
            .run(input.channelId, input.creatorParticipantId);
          db.prepare('INSERT INTO channel_operations (operation_id, fingerprint, channel_id) VALUES (?, ?, ?)')
            .run(operationId, fingerprint, input.channelId);
          db.prepare("INSERT INTO discovery_visibility (channel_id, visibility, visibility_epoch, revision) VALUES (?, 'secret', 1, 1)")
            .run(input.channelId);
          return { kind: 'created', channelId: input.channelId as RoomId } as const;
        });
        if (result.kind === 'created') handle.publish({ kind: 'channel', channelId: result.channelId });
        return result;
      } catch { return unavailable(); }
    },

    activate(input) {
      const { binding } = input;
      try {
        return handle.transaction(db => {
          const recorded = db.prepare(ACTIVATION_SELECT).get(input.operationKey) as ActivationRow | undefined;
          if (recorded) {
            const activation = activationFromRow(recorded);
            return sameSessionBinding(activation.binding, binding) && activation.channelId === input.channelId
              && activation.sessionGeneration === input.sessionGeneration
              ? { kind: 'activated', activation } as const
              : { kind: 'rejected' } as const;
          }
          // Only an admitted agent, on the device admission reserved for it, is ever bound.
          const joined = db.prepare(`
            SELECT 1 FROM memberships m
            JOIN participants p ON p.participant_id = m.participant_id
            JOIN devices d ON d.participant_id = m.participant_id
            WHERE m.channel_id = ? AND m.participant_id = ? AND m.membership = 'joined'
              AND p.kind = 'agent' AND p.owner_id = ? AND d.device_id = ?
          `).get(input.channelId, binding.agentParticipantId, binding.ownerId, binding.deviceId);
          if (!joined || db.prepare('SELECT 1 FROM bindings WHERE binding_id = ?').get(binding.bindingId)) {
            return { kind: 'rejected' } as const;
          }
          db.prepare(`
            INSERT INTO bindings (binding_id, generation, owner_id, participant_id, device_id, harness, session_id, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
          `).run(
            binding.bindingId, binding.generation, binding.ownerId, binding.agentParticipantId,
            binding.deviceId, binding.harness, binding.sessionId,
          );
          db.prepare(`
            INSERT INTO discovery_activations (operation_key, binding_id, generation, channel_id, session_generation)
            VALUES (?, ?, ?, ?, ?)
          `).run(input.operationKey, binding.bindingId, binding.generation, input.channelId, input.sessionGeneration);
          return {
            kind: 'activated',
            activation: activationFromRow(db.prepare(ACTIVATION_SELECT).get(input.operationKey) as ActivationRow),
          } as const;
        });
      } catch { return unavailable(); }
    },

    activation(operationKey) {
      try {
        const row = handle.read(db => db.prepare(ACTIVATION_SELECT).get(operationKey) as ActivationRow | undefined);
        return row ? { kind: 'found', activation: activationFromRow(row) } : { kind: 'absent' };
      } catch { return unavailable(); }
    },

    findSecretChannel(idempotencyKey) {
      try {
        const row = handle.read(db => db.prepare('SELECT channel_id FROM channel_operations WHERE operation_id = ?')
          .get(`${CREATE_OPERATION_PREFIX}${idempotencyKey}`) as { channel_id: string } | undefined);
        return row ? { kind: 'already_created', channelId: row.channel_id as RoomId } : { kind: 'absent' };
      } catch { return unavailable(); }
    },
  };
  return store;
}
