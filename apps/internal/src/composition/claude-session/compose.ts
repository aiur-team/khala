import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '@aiur/khala/cli/errors';
import { MAX_SEND_BYTES, SendService } from '@aiur/khala/cli/send';
import type { AccessRequestInput, AccessStatusInput, ChannelAccessResult, ChannelListInput } from '@aiur/khala/cli/channels/types';
import type { CreateRequestInput } from '@aiur/khala/cli/channels/create/types';
import {
  type ClaudeBindingServices, type ClaudeSessionAccess, type ClaudeSessionAdapter, createClaudeSessionAdapter,
} from '@aiur/khala/composition/claude-session';
import { CLAUDE_SESSION_PATH, handleClaudeSessionRequest } from '@aiur/khala/composition/claude-session-http';
import { openClaudeSessionState } from '@aiur/khala/composition/claude-session-state';
import { createInternalClient, readInternalDescriptor } from '@aiur/khala/composition/internal';
import { activateInternalAccess } from '@aiur/khala/composition/internal-activation';
import {
  type InternalDiscoveryCallResult, createInternalDiscoveryClient, selectInternalDiscovery,
} from '@aiur/khala/composition/internal-discovery';
import { type SessionBinding, decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import { type GrantedDescriptor, encodeInternalDescriptor, isGrantedDescriptor } from '@khala/contracts/internal/descriptor';
import {
  INTERNAL_DISCOVERY_DESCRIPTOR_FILE, INTERNAL_DISCOVERY_DIRECTORY,
} from '@khala/contracts/internal/discovery-descriptor';
import type { RoomId } from '@khala/contracts/messaging/index';
import { claudeCapabilities } from '@khala/harnesses/claude/capabilities';
import { activeDescriptorPath, writePrivateFile } from '../../descriptor/write';
import type { AgentSessionRoute } from '../../server/channel-server';
import type { ChannelStore } from '../../store/channel-store';
import { discoveryPrincipal, sessionDigest } from '../channel-discovery/service';
import { issueDiscoveryDescriptor } from '../discovery-descriptor';

// The Claude plugin's session route in the internal launcher's server. Hooks and the
// plugin's `mcp-serve` present the launch's transport capability from `active.json`
// and name their `CLAUDE_CODE_SESSION_ID`; nothing else selects a binding.
//
// Each Claude session joins as its own discovery identity (`harness: claude`, that
// session ID), so its access request is journaled for that session only. An approved
// request is activated through the same journaled connector path `khala join` uses,
// into a granted descriptor kept beside that identity rather than the shared
// `active.json`. The session then resolves only to the binding its own granted
// descriptor names, and only while the store holds that binding active for its
// session digest; before a grant it resolves to nothing.

export const CLAUDE_HARNESS = 'claude';
/** The per-session granted descriptor beside the session's discovery descriptor. */
export const CLAUDE_GRANT_FILE = 'claude-grant.json';
const STATE_DIRECTORY = 'claude-session';
/** Answers that may still owe a local binding; a `connected` one after a launcher restart. */
const ACTIVATABLE: ReadonlySet<string> = new Set(['approved', 'connecting', 'connected', 'repair_required']);
/** The installation principal: every Claude session of this launch shares it. */
const INSTALLATION = { principalId: 'installation' } as const;

export type ClaudeSessionCompositionOptions = Readonly<{
  /** The private internal root holding `active.json` and `discovery/`. */
  root: string;
  store: ChannelStore;
  /** The launch's transport capability, the only credential this route accepts. */
  transportCapability: string;
  fetch?: typeof fetch;
  clock?: () => number;
}>;

export type ClaudeSessionComposition = Readonly<{ adapter: ClaudeSessionAdapter; route: AgentSessionRoute }>;

export async function composeClaudeSession(options: ClaudeSessionCompositionOptions): Promise<ClaudeSessionComposition> {
  const { root, store } = options;
  const expected = Buffer.from(options.transportCapability);
  const paths = (sessionId: string) => {
    const directory = path.join(root, INTERNAL_DISCOVERY_DIRECTORY, discoveryPrincipal(CLAUDE_HARNESS, sessionId));
    return { descriptorPath: path.join(directory, INTERNAL_DISCOVERY_DESCRIPTOR_FILE), grantPath: path.join(directory, CLAUDE_GRANT_FILE) };
  };
  const discovery = (sessionId: string) => createInternalDiscoveryClient({
    select: () => selectInternalDiscovery({ descriptorPath: paths(sessionId).descriptorPath, activePath: activeDescriptorPath(root) }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  // Issuing rotates the identity, so concurrent first calls of one session share a single
  // issuance; a call that finds the identity already reissued since it looked just uses it.
  const issuing = new Map<string, Promise<boolean>>();
  const descriptorText = (sessionId: string): string | null => {
    try { return fs.readFileSync(paths(sessionId).descriptorPath, 'utf8'); } catch { return null; }
  };

  /** Issues this session's discovery identity once; a rotated or missing one is reissued. */
  async function withIdentity(sessionId: string, run: () => Promise<InternalDiscoveryCallResult>): Promise<InternalDiscoveryCallResult> {
    const seen = descriptorText(sessionId);
    const first = await run();
    if (first.kind !== 'discovery_required') return first;
    let pending = issuing.get(sessionId);
    if (pending === undefined) {
      pending = (async () => {
        if (descriptorText(sessionId) !== seen) return true;
        const issued = await issueDiscoveryDescriptor({
          root,
          command: { kind: 'discovery', harness: CLAUDE_HARNESS, sessionId, displayLabel: null, workspaceLabel: null },
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        return issued.kind === 'issued';
      })().finally(() => issuing.delete(sessionId));
      issuing.set(sessionId, pending);
    }
    return await pending ? run() : { kind: 'unavailable' };
  }

  /** Finishes an approved request for exactly this session, into its own granted descriptor. */
  async function activate(sessionId: string, operationId: string, outcome: string): Promise<string> {
    const { descriptorPath, grantPath } = paths(sessionId);
    // A `connected` answer this session's grant cannot back is never reported as connected.
    const fallback = outcome === 'connected' ? 'unavailable' : outcome;
    const selected = selectInternalDiscovery({ descriptorPath, activePath: activeDescriptorPath(root) });
    if (selected.kind !== 'selected' || !prepareGrant(sessionId, grantPath)) return fallback;
    const activated = await activateInternalAccess({
      descriptorPath, descriptor: selected.selection.descriptor, origin: selected.selection.origin, operationId,
      // The approved channel need not be the launch channel; the grant records the one it names.
      activePath: grantPath, adoptChannel: true, repair: outcome === 'repair_required', fetch: options.fetch, clock: options.clock,
    });
    return activated === 'unavailable' ? fallback : activated;
  }

  /**
   * Seeds the session's granted descriptor from the launch. A live grant is kept, so a
   * session holds one binding at a time; a grant the store no longer holds is dropped, and
   * so is one from an earlier launch, whose capability ended with it.
   */
  function prepareGrant(sessionId: string, grantPath: string): boolean {
    const launch = readInternalDescriptor(activeDescriptorPath(root));
    if (!launch.ok) return false;
    const held = readInternalDescriptor(grantPath);
    if (held.ok && held.value.origin === launch.value.origin && fromThisLaunch(held.value)
      && (!isGrantedDescriptor(held.value) || bound(sessionId) !== null)) return true;
    const { v, channelId, origin, transportCapability } = launch.value;
    try {
      writePrivateFile(path.dirname(grantPath), path.basename(grantPath), encodeInternalDescriptor({ v, channelId, origin, transportCapability }));
      return true;
    } catch {
      return false;
    }
  }

  /** The session's granted descriptor, when it holds a grant issued during this launch. */
  function grant(sessionId: string): GrantedDescriptor | null {
    const held = readInternalDescriptor(paths(sessionId).grantPath);
    return held.ok && isGrantedDescriptor(held.value) && fromThisLaunch(held.value) ? held.value : null;
  }

  /** This launch seeds every grant file with its transport capability; a resumed launch mints a new one. */
  function fromThisLaunch(descriptor: Readonly<{ transportCapability: string }>): boolean {
    const presented = Buffer.from(descriptor.transportCapability);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  /**
   * The binding the session's own grant names, only while the store holds it active for
   * this session's digest. The grant and the binding it selects can therefore never differ.
   */
  function bound(sessionId: string): SessionBinding | null {
    const held = grant(sessionId);
    if (held === null) return null;
    const found = store.sessionBinding({
      bindingId: held.bindingId, harness: CLAUDE_HARNESS, sessionId: sessionDigest(CLAUDE_HARNESS, sessionId),
    });
    if (found.kind !== 'done' || found.binding === null) return null;
    const { v, bindingId, ownerId, agentParticipantId, deviceId, harness, sessionId: stored, generation } = found.binding;
    return { v, bindingId, ownerId, agentParticipantId, deviceId, harness, sessionId: stored, generation };
  }

  function accessResult(result: InternalDiscoveryCallResult): ChannelAccessResult {
    if (result.kind === 'ok') return { kind: 'status', status: result.body };
    if (result.kind === 'discovery_required') return { kind: 'refused', code: 'discovery_required' };
    if (result.kind === 'refused') {
      switch (result.status) {
        case 400: return { kind: 'refused', code: 'invalid_request' };
        case 403: return { kind: 'refused', code: 'discovery_denied' };
        case 404: return { kind: 'refused', code: 'not_found' };
        case 409: return { kind: 'refused', code: 'operation_conflict' };
        case 429: return { kind: 'refused', code: 'rate_limited' };
      }
    }
    return { kind: 'unavailable' };
  }

  /** An approved status is activated before it is answered, as `khala join` does. */
  async function answered(sessionId: string, result: InternalDiscoveryCallResult): Promise<ChannelAccessResult> {
    const access = accessResult(result);
    if (access.kind !== 'status' || !isStatus(access.status) || !ACTIVATABLE.has(access.status.outcome)) return access;
    const outcome = await activate(sessionId, access.status.operationId, access.status.outcome);
    return { kind: 'status', status: { ...access.status, outcome } };
  }

  const access: ClaudeSessionAccess = {
    async listChannels(_principal, sessionId, input: ChannelListInput) {
      const listed = await discovery(sessionId).listChannels(input);
      if (listed.kind !== 'refused' || listed.code !== 'discovery_required') return listed;
      await withIdentity(sessionId, async () => ({ kind: 'discovery_required' }));
      return discovery(sessionId).listChannels(input);
    },
    async request(_principal, sessionId, input: AccessRequestInput) {
      if (!localOrigin(input.origin)) return { kind: 'refused', code: 'untrusted_origin' };
      const body = input.target.kind === 'channel_url'
        ? { v: 1 as const, kind: 'channel_url' as const, operationId: input.operationId, channelUrl: input.target.channelUrl }
        : { v: 1 as const, kind: 'listing_ref' as const, operationId: input.operationId, listingRef: input.target.listingRef };
      return answered(sessionId, await withIdentity(sessionId, () => discovery(sessionId).requestAccess(body)));
    },
    async status(_principal, sessionId, input: AccessStatusInput) {
      if (!localOrigin(input.origin)) return { kind: 'refused', code: 'untrusted_origin' };
      return answered(sessionId, await withIdentity(sessionId, () => discovery(sessionId).status('access', input.operationId)));
    },
    // A create intent only asks: like `khala channels create`, nothing is activated here.
    async create(_principal, sessionId, input: CreateRequestInput) {
      if (!localOrigin(input.origin)) return { kind: 'refused', code: 'untrusted_origin' };
      return accessResult(await withIdentity(sessionId, () => discovery(sessionId).requestCreate({
        operationId: input.operationId, proposedTitle: input.title,
      })));
    },
  };

  function localOrigin(origin: string | null): boolean {
    if (origin === null) return true;
    const launch = readInternalDescriptor(activeDescriptorPath(root));
    return launch.ok && launch.value.origin === origin;
  }

  const limits = decodeDeliveryLimits({ maxPayloadBytes: MAX_SEND_BYTES, maxSelectionEvents: 32 });
  if (!limits.ok) throw new Error('claude session: invalid delivery limits');
  // No installed Claude version is inspected here, so every route stays unproven.
  const capabilities = claudeCapabilities(null, limits.value);

  function services(binding: SessionBinding): ClaudeBindingServices {
    const client = createInternalClient({
      descriptorPath: paths(binding.sessionId).grantPath,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const unproven = async (): Promise<never> => { throw new CliError('transport_unavailable'); };
    return {
      // Claude's acknowledgement route is unproven, so the adapter refuses every pull and
      // read before it reaches this port; nothing is ever pulled into an inbox here.
      read: { read: unproven },
      async send(input) {
        if (input.acknowledgeToken !== undefined) return unproven();
        return { value: await new SendService(client).send(input.body, binding.bindingId), batch: null };
      },
      setMode: unproven,
      // No listening-mode application is composed for internal mode yet.
      readMode: async () => ({ ok: false, code: 'unavailable' }),
      capabilities: async () => capabilities,
      // No local automation fence is composed: nothing pending, and no idle watcher.
      pending: async () => ({ pending: false }),
      watchWindow: async () => null,
      roster: async () => {
        const held = grant(binding.sessionId);
        return held === null || held.bindingId !== binding.bindingId ? { kind: 'refused', code: 'not_joined' } : roster(held.channelId as RoomId);
      },
    };
  }

  /** The joined agents of the channel the session's grant names. */
  function roster(channelId: RoomId): unknown {
    const result = store.roster(channelId);
    if (result.kind !== 'done') return { kind: 'unavailable' };
    const participants = result.participants;
    const agents = [];
    for (const participant of participants) {
      if (participant.kind !== 'agent') continue;
      const channel = store.channel({ channelId, participantId: participant.participantId });
      if (channel.kind !== 'done' || channel.channel.membership !== 'joined') continue;
      const owner = participants.find(each => each.kind === 'human' && each.ownerId === participant.ownerId);
      agents.push({
        v: 1, participantId: participant.participantId, displayName: participant.displayName,
        ownerDisplayName: owner?.displayName ?? 'Owner', connection: 'unknown',
      });
    }
    return { kind: 'listed', roster: { v: 1, agents } };
  }

  const adapter = createClaudeSessionAdapter({
    authenticator: {
      async authenticate(credential) {
        const presented = Buffer.from(credential);
        return presented.length === expected.length && timingSafeEqual(presented, expected) ? INSTALLATION : null;
      },
    },
    sessions: {
      async resolve(principal, claim) {
        if (principal.principalId !== INSTALLATION.principalId || claim.harness !== CLAUDE_HARNESS) return null;
        const binding = bound(claim.sessionId);
        // The store keeps the session digest; the adapter selects by the session it was named.
        return binding === null ? null : { ...binding, sessionId: claim.sessionId };
      },
    },
    state: await openClaudeSessionState(path.join(root, STATE_DIRECTORY)),
    services,
    access,
  });

  return {
    adapter,
    route: {
      path: CLAUDE_SESSION_PATH,
      handle: input => handleClaudeSessionRequest(adapter, {
        authorization: input.authorization, body: input.body, readBudgetBytes: MAX_SEND_BYTES,
      }),
    },
  };
}

function isStatus(value: unknown): value is Readonly<{ v: 1; operationId: string; outcome: string }> {
  return typeof value === 'object' && value !== null && typeof (value as { operationId?: unknown }).operationId === 'string'
    && typeof (value as { outcome?: unknown }).outcome === 'string';
}
