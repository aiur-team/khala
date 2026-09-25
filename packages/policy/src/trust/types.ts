// Trust policy state for one recipient binding. Requested and effective policy are
// separate facts: the control service accepting a request is not enforcement, and
// only a matching connector acknowledgment moves the effective revision.

import type {
  BindingId, CommandId, ListeningModeControl, OwnerAuthority, OwnerId, ParticipantId, PolicyAckErrorCode,
  PolicySetCommand, RoomId,
} from '@khala/contracts/delivery/index';
import type { ListeningModeOperationEntry } from '../listening-mode/store';

export type PolicyMode = PolicySetCommand['mode'];

/**
 * One numbered policy revision. `commandId` is null only for the review baseline a
 * binding starts with, including the baseline a rebind installs for its new
 * generation; no connector acknowledgment can name that revision.
 */
export type PolicyRevision = Readonly<{
  version: number;
  generation: number;
  commandId: CommandId | null;
  mode: PolicyMode;
  paused: boolean;
  /** The one peer whose events this revision may release automatically. */
  peerParticipantId: ParticipantId | null;
}>;

/**
 * The latest connector observation for the current request. `state` mirrors the
 * connector's own report; `errorCode` is set only when it rejected the request.
 */
export type ConnectorObservation = Readonly<{
  commandId: CommandId;
  state: 'pending' | 'offline' | 'rejected';
  errorCode: PolicyAckErrorCode | null;
}>;

export type PolicyChangeRejection =
  | 'forbidden'
  | 'binding_mismatch'
  | 'stale_binding'
  | 'stale_policy'
  | 'idempotency_conflict'
  | 'automation_gated'
  | 'binding_revoked';

export type PolicyChangeOutcome =
  | Readonly<{ ok: true; requested: PolicyRevision }>
  | Readonly<{ ok: false; code: PolicyChangeRejection }>;

/** One settled policy command, kept so a retry returns its original outcome. */
export type JournalEntry = Readonly<{
  command: PolicySetCommand;
  outcome: PolicyChangeOutcome;
}>;

export type TrustState = Readonly<{
  roomId: RoomId;
  bindingId: BindingId;
  ownerId: OwnerId;
  /** The binding generation this state belongs to. */
  generation: number;
  /** Always the newest accepted revision; its version is the CAS value. */
  requested: PolicyRevision;
  /** The newest revision a connector acknowledged as enforced; null when unknown. */
  effective: PolicyRevision | null;
  connector: ConnectorObservation | null;
  journal: ReadonlyMap<CommandId, JournalEntry>;
  /** Durable listening control; effective mode is always derived from current capabilities. */
  listeningMode: ListeningModeControl;
  /** Successful listening operations retained independently from policy commands. */
  listeningModeJournal: ReadonlyMap<string, ListeningModeOperationEntry>;
}>;

/**
 * Who is asking. Only an owner actor carries authority, and trusted composition
 * builds it after authenticating the owner session. Peer messages and model tool
 * calls are represented so callers can pass them through and be refused.
 */
export type PolicyActor =
  | Readonly<{ kind: 'owner'; authority: OwnerAuthority }>
  | Readonly<{ kind: 'peer'; participantId: ParticipantId }>
  | Readonly<{ kind: 'model'; bindingId: BindingId }>;

/**
 * Limits approved through G-AUTOMATION. There is deliberately no default and no
 * caller can supply one: the only source is the closed seam in `gate.ts`.
 */
export type AutomationConfig = Readonly<{
  /** Automatic releases stop once a causal chain reaches this depth. */
  maxCausalDepth: number;
}>;

/**
 * The binding's revocation status as the control plane records it, supplied by
 * trusted composition. Revocation is terminal for trust: no policy change, re-arm
 * or rebind applies to a revoked binding.
 */
export type BindingStatus = 'active' | 'revoked';

/** Instruction for trust-controls composition to deliver to the owner connector. */
export type PublishPolicyEffect = Readonly<{
  kind: 'publish_policy';
  bindingId: BindingId;
  revision: PolicyRevision;
}>;

/** What a status surface may claim; `requested` never implies enforcement. */
export type TrustView = Readonly<{
  requested: Readonly<{ version: number; mode: PolicyMode; paused: boolean }>;
  effective: Readonly<{ version: number; mode: PolicyMode; paused: boolean }> | null;
  status: 'effective' | 'requested' | 'rejected';
  connectorState: ConnectorObservation['state'] | null;
}>;
