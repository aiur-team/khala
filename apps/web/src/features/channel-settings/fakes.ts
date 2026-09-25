import type { ChannelListing, ChannelVisibility, OperationResult, RoomId, StableAgentPrincipal } from '@khala/contracts/messaging/index';
import { projectListing, toAllowlisted } from './model';
import type {
  AllowlistChange,
  AllowlistRejection,
  AllowlistedAgent,
  ChannelSettingsPort,
  ChannelSettingsSnapshot,
  KnownAgentPrincipal,
  MutationApplied,
  SettingsRejection,
  VisibilityChange,
} from './ports';

/**
 * In-memory owner catalog for tests and the browser harness only. It mirrors
 * the control plane's rules (absence is secret, revision CAS, owner-only
 * mutation, same-owner or allowlisted private eligibility) so a test can ask
 * what another agent session would list after the UI acts.
 */
export type FakeCatalog = {
  port: ChannelSettingsPort;
  /** What a discovery session for `principal` (owned by `ownerId`) would list. */
  listFor(requester: Readonly<{ ownerId: string; principal: string }>): readonly ChannelListing[];
  entry(): ChannelSettingsSnapshot;
  /** Simulates a concurrent edit from another tab. */
  bumpRevision(change?: Partial<Pick<ChannelSettingsSnapshot, 'visibility' | 'listedTitle'>>): void;
  revokeOwnership(): void;
  /** The agent's session rebinds; the owner's open picker is now stale. */
  rebind(principal: string): void;
  calls: { setVisibility: VisibilityChange[]; updateAllowlist: AllowlistChange[] };
  /** Queue results that replace the next mutation's outcome. */
  failNext: Array<'unavailable' | SettingsRejection>;
};

export const OWNER_ID = 'owner-a';

export const KNOWN_AGENTS: readonly KnownAgentPrincipal[] = [
  {
    principal: 'principal-own' as StableAgentPrincipal,
    fingerprint: 'SHA256:own-7Q2c',
    sessionGeneration: 3,
    source: 'own_session',
    displayLabel: 'my laptop agent',
    workspaceLabel: '~/src/khala',
  },
  {
    principal: 'principal-peer' as StableAgentPrincipal,
    fingerprint: 'SHA256:peer-9Xb1',
    sessionGeneration: 1,
    source: 'pairing',
    // Agent-controlled labels can claim anything; the UI must not trust them.
    displayLabel: 'Your agent (trusted)',
    workspaceLabel: null,
  },
];

/** Agent owner for each known principal, kept server-side. */
const AGENT_OWNERS: Readonly<Record<string, string>> = { 'principal-own': OWNER_ID, 'principal-peer': 'owner-b' };

export function createFakeCatalog(
  options: Readonly<{
    roomId?: RoomId;
    channelName?: string;
    publicDiscovery?: 'enabled' | 'disabled';
    initial?: Readonly<{ visibility: ChannelVisibility; listedTitle: string | null; allowlist?: readonly AllowlistedAgent[] }>;
    known?: readonly KnownAgentPrincipal[];
    delayMs?: number;
  }> = {},
): FakeCatalog {
  const roomId = options.roomId ?? ('!channel:example.test' as RoomId);
  const delay = () => (options.delayMs ? new Promise(resolve => setTimeout(resolve, options.delayMs)) : Promise.resolve());
  let canManage = true;
  let snapshot: ChannelSettingsSnapshot = {
    roomId,
    channelName: options.channelName ?? 'Release planning',
    visibility: options.initial?.visibility ?? 'secret',
    listedTitle: options.initial?.listedTitle ?? null,
    revision: options.initial ? '1' : null,
    allowlist: options.initial?.allowlist ?? [],
    publicDiscovery: options.publicDiscovery ?? 'enabled',
    canManage: true,
  };
  let known = options.known ?? KNOWN_AGENTS;
  const operations = new Map<string, string>();
  const calls: FakeCatalog['calls'] = { setVisibility: [], updateAllowlist: [] };
  const failNext: FakeCatalog['failNext'] = [];

  function queuedFailure(): OperationResult<never, SettingsRejection> | null {
    const next = failNext.shift();
    if (!next) return null;
    return next === 'unavailable' ? { kind: 'unavailable', retryable: true } : { kind: 'rejected', code: next };
  }

  function nextRevision(): string {
    return String(Number(snapshot.revision ?? '0') + 1);
  }

  const port: ChannelSettingsPort = {
    async read() {
      await delay();
      if (!canManage) return { kind: 'rejected', code: 'forbidden' };
      return { kind: 'ok', value: snapshot };
    },

    async setVisibility(input): Promise<OperationResult<MutationApplied, SettingsRejection>> {
      calls.setVisibility.push(input);
      await delay();
      const failure = queuedFailure();
      if (failure) return failure;
      if (!canManage) return { kind: 'rejected', code: 'forbidden' };
      const fingerprint = JSON.stringify([input.visibility, input.title]);
      const prior = operations.get(input.operationId);
      if (prior !== undefined) return prior === fingerprint ? { kind: 'ok', value: { revision: snapshot.revision } } : { kind: 'rejected', code: 'operation_mismatch' };
      if (input.expectedRevision !== snapshot.revision) return { kind: 'rejected', code: 'stale_revision' };
      if (input.visibility === 'public' && snapshot.publicDiscovery !== 'enabled') return { kind: 'rejected', code: 'public_discovery_disabled' };
      operations.set(input.operationId, fingerprint);
      if (snapshot.revision === null && input.visibility === 'secret') return { kind: 'ok', value: { revision: null } };
      snapshot = { ...snapshot, visibility: input.visibility, listedTitle: input.title, revision: nextRevision() };
      return { kind: 'ok', value: { revision: snapshot.revision } };
    },

    async updateAllowlist(input): Promise<OperationResult<MutationApplied, AllowlistRejection>> {
      calls.updateAllowlist.push(input);
      await delay();
      const failure = queuedFailure();
      if (failure) return failure as OperationResult<never, AllowlistRejection>;
      if (!canManage) return { kind: 'rejected', code: 'forbidden' };
      if (input.expectedRevision !== snapshot.revision) return { kind: 'rejected', code: 'stale_revision' };
      const agentRecord = known.find(agent => agent.principal === input.principal);
      if (input.action === 'allow') {
        if (!agentRecord) return { kind: 'rejected', code: 'forbidden' };
        if (agentRecord.sessionGeneration !== input.expectedSessionGeneration) return { kind: 'rejected', code: 'stale_revision' };
        const agent = toAllowlisted(agentRecord);
        snapshot = { ...snapshot, allowlist: [...snapshot.allowlist.filter(item => item.principal !== agent.principal), agent], revision: nextRevision() };
      } else {
        snapshot = { ...snapshot, allowlist: snapshot.allowlist.filter(item => item.principal !== input.principal), revision: nextRevision() };
      }
      return { kind: 'ok', value: { revision: snapshot.revision } };
    },

    async knownPrincipals() {
      await delay();
      if (!canManage) return { kind: 'rejected', code: 'forbidden' };
      return { kind: 'ok', value: known };
    },
  };

  return {
    port,
    calls,
    failNext,
    entry: () => snapshot,
    listFor(requester) {
      if (snapshot.visibility === 'secret' || snapshot.listedTitle === null) return [];
      if (snapshot.visibility === 'public' && snapshot.publicDiscovery !== 'enabled') return [];
      const eligible = snapshot.visibility === 'public'
        || requester.ownerId === OWNER_ID
        || snapshot.allowlist.some(item => item.principal === requester.principal && AGENT_OWNERS[item.principal] === requester.ownerId);
      if (!eligible) return [];
      const preview = projectListing(snapshot.visibility, snapshot.listedTitle);
      return preview.kind === 'listed' ? [preview.listing] : [];
    },
    bumpRevision(change = {}) {
      snapshot = { ...snapshot, ...change, revision: nextRevision() };
    },
    revokeOwnership() {
      canManage = false;
    },
    rebind(principal) {
      known = known.map(agent => (agent.principal === principal ? { ...agent, sessionGeneration: agent.sessionGeneration + 1 } : agent));
    },
  };
}
