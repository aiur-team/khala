import type {
  CallOptions,
  ChannelVisibility,
  OperationResult,
  RoomId,
  StableAgentPrincipal,
} from '@khala/contracts/messaging/index';

/**
 * Where the owner already knows an agent from. Never a directory lookup: the
 * picker only offers principals the owner has a verified relationship with.
 */
export type KnownPrincipalSource = 'own_session' | 'pairing' | 'approved_access';

/**
 * One agent the owner can allow. `fingerprint` is server-verified and is the
 * identity the owner decides on; `displayLabel` and `workspaceLabel` come from
 * the agent side and are shown only as untrusted hints.
 */
export type KnownAgentPrincipal = Readonly<{
  principal: StableAgentPrincipal;
  fingerprint: string;
  /** Current session generation the owner inspected; `allow` is bound to it. */
  sessionGeneration: number;
  source: KnownPrincipalSource;
  displayLabel: string | null;
  workspaceLabel: string | null;
}>;

export type AllowlistedAgent = Readonly<{
  principal: StableAgentPrincipal;
  fingerprint: string;
  /** Current session generation; `revoke` sends it with the mutation. */
  sessionGeneration: number;
  displayLabel: string | null;
  workspaceLabel: string | null;
}>;

/**
 * Owner-side discovery settings for one external channel. A channel with no
 * catalog entry is `secret` with a null `revision`.
 */
export type ChannelSettingsSnapshot = Readonly<{
  roomId: RoomId;
  /** Owner-facing channel name, offered as the default listed title. */
  channelName: string;
  visibility: ChannelVisibility;
  /** The title agents see when listed; null exactly when `secret`. */
  listedTitle: string | null;
  revision: string | null;
  allowlist: readonly AllowlistedAgent[];
  /** Hosted public discovery stays disabled until rollout enables it. */
  publicDiscovery: 'enabled' | 'disabled';
  /** Whether the signed-in human currently owns the channel. */
  canManage: boolean;
}>;

export type VisibilityChange = Readonly<{
  v: 1;
  operationId: string;
  roomId: RoomId;
  visibility: ChannelVisibility;
  title: string | null;
  expectedRevision: string | null;
}>;

export type AllowlistChange = Readonly<{
  v: 1;
  action: 'allow' | 'revoke';
  operationId: string;
  roomId: RoomId;
  principal: StableAgentPrincipal;
  expectedSessionGeneration: number;
  expectedRevision: string;
}>;

export type SettingsRejection = 'forbidden' | 'stale_revision' | 'operation_mismatch' | 'public_discovery_disabled' | 'invalid_title';
export type AllowlistRejection = 'forbidden' | 'stale_revision' | 'operation_mismatch';

/** `revision` is null when the change left the channel unregistered (secret). */
export type MutationApplied = Readonly<{ revision: string | null }>;

/**
 * Owner-only settings port. Its live implementation wraps
 * `PUT /api/human/channel-discovery/settings` and
 * `POST /api/human/channel-discovery/allowlist`, which authenticate the human
 * session and recheck channel ownership on every call.
 */
export interface ChannelSettingsPort {
  read(roomId: RoomId, options?: CallOptions): Promise<OperationResult<ChannelSettingsSnapshot, 'forbidden'>>;
  setVisibility(input: VisibilityChange, options?: CallOptions): Promise<OperationResult<MutationApplied, SettingsRejection>>;
  updateAllowlist(input: AllowlistChange, options?: CallOptions): Promise<OperationResult<MutationApplied, AllowlistRejection>>;
  /**
   * Stable principals known to this owner through their own sessions,
   * completed pairing, or prior approved access. There is deliberately no
   * query parameter: the picker never searches a global or free-text directory.
   */
  knownPrincipals(options?: CallOptions): Promise<OperationResult<readonly KnownAgentPrincipal[], 'forbidden'>>;
}

export interface ChannelSettingsPorts {
  readonly settings: ChannelSettingsPort;
}
