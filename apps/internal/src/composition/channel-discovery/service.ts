import { createHash, randomBytes } from 'node:crypto';
import {
  type AuthPrincipal, type AuthorizedChannelRef, type ChannelAccessRequesterContext, type ChannelAccessResolutionPort,
  type ChannelCreateAdapterPort, type ChannelCreateReconciliation, type ControlStore, type DiscoveryRequester,
  type StableAgentPrincipal, type TrustedClock, validateGrantExchangeRequest,
} from '@khala/contracts/messaging/index';
import { createGrantExchangeAuthority } from '@khala/messaging/channel-access/exchange/authority';
import { createExchangeGrantIssuer } from '@khala/messaging/channel-access/exchange/grants';
import type { ChannelAdmissionProviderPort, ChannelAdmissionRequest } from '@khala/messaging/channel-access/exchange/ports';
import { createGrantExchangeService } from '@khala/messaging/channel-access/exchange/service';
import { createChannelAccessPolicy } from '@khala/messaging/channel-access/journal/policy';
import { createChannelAccessService } from '@khala/messaging/channel-access/journal/service';
import { createChannelAccessStore } from '@khala/messaging/channel-access/journal/store';
import type { HumanAuthority } from '../../server/credentials';
import {
  type DiscoveryAgentContext, type DiscoveryAgentView, type DiscoverySettingsView, type InternalDiscoveryPort,
  ed25519Thumbprint,
} from '../../server/discovery';
import type { DiscoveryAgent, DiscoveryStore } from '../../store/discovery-store';
import { createInternalListing } from './listing';

// Internal-mode composition of channel discovery. The shared channel-access
// journal, grant exchange and grant issuer run unchanged over the channel
// store's SQLite `ControlStore`; this module supplies only the local adapters:
// catalog resolution, admission, the human-workflow-only create adapter and
// descriptor issuance. The single local human owns every channel. Agents never
// receive a channel ID, owner, roster or grant from any of these surfaces.

const JOURNAL_KEY_RECORD = 'internal.channel-access.policy-key.v1';
const OWNER_REVISION = 'internal-owner-v1';
const CAPABILITY_BYTES = 32;
const CHANNEL_PATH = /^\/channels\/([A-Za-z0-9._~-]{1,256})$/;
/**
 * Server-only channel reference. A listing-reference request stays bound to the
 * requester's eligibility, so an allowlist revoke closes it; a canonical URL is a
 * locator that never needed eligibility.
 */
const LISTED_PREFIX = 'listed:';

function channelOf(channelRef: string): Readonly<{ channelId: string; listed: boolean }> {
  return channelRef.startsWith(LISTED_PREFIX)
    ? { channelId: channelRef.slice(LISTED_PREFIX.length), listed: true }
    : { channelId: channelRef, listed: false };
}

export type InternalChannelDiscovery = Readonly<{
  port: InternalDiscoveryPort;
  /** Human-workflow-only; consumed by `channel-create-workflow`, never reachable from an agent route. */
  createAdapter: ChannelCreateAdapterPort;
  admission: ChannelAdmissionProviderPort;
}>;

export type InternalChannelDiscoveryDeps = Readonly<{
  control: ControlStore;
  store: DiscoveryStore;
  human: HumanAuthority;
  clock: TrustedClock;
  newChannelId: () => string;
}>;

export function capabilityDigest(capability: string): string {
  return createHash('sha256').update(`khala.internal.discovery-capability.v1\0${capability}`).digest('hex');
}

function digest(purpose: string, ...fields: readonly string[]): string {
  return createHash('sha256').update([`khala.internal.${purpose}.v1`, ...fields].join('\0')).digest('base64url');
}

export function discoveryPrincipal(harness: string, sessionId: string): string {
  return `agent_${digest('principal', harness, sessionId)}`;
}

function agentParticipant(principal: string): string {
  return `participant_${principal}`;
}

/** Loads the durable 32-byte journal HMAC key, creating it exactly once. */
async function journalKey(control: ControlStore): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await control.read<string>(JOURNAL_KEY_RECORD);
    if (read.kind === 'record') return Buffer.from(read.record.value, 'base64url');
    if (read.kind === 'unavailable') break;
    const created = await control.compareAndSet<string>({
      key: JOURNAL_KEY_RECORD,
      expectedRevision: null,
      operationId: `create-policy-key-${randomBytes(12).toString('base64url')}`,
      next: { value: randomBytes(32).toString('base64url'), expiresAt: null },
    });
    if (created.kind === 'applied') return Buffer.from(created.record.value, 'base64url');
  }
  throw new Error('internal channel discovery: journal key unavailable');
}

export async function composeInternalChannelDiscovery(deps: InternalChannelDiscoveryDeps): Promise<InternalChannelDiscovery> {
  const { store, human, clock } = deps;
  const policy = createChannelAccessPolicy({ key: await journalKey(deps.control) });
  const listing = createInternalListing({ store, clock });
  const owner: AuthPrincipal = {
    v: 1,
    ownerId: human.ownerId,
    providerIssuer: 'khala-internal',
    providerSubject: human.participantId,
    verifiedEmail: 'owner@localhost',
    sessionExpiresAt: '9999-12-31T23:59:59Z',
  };

  function currentAgent(principal: string, generation: number): DiscoveryAgent | 'revoked' | 'unavailable' {
    const found = store.agent(principal);
    if (found.kind === 'unavailable') return 'unavailable';
    return found.kind === 'found' && found.agent.generation === generation ? found.agent : 'revoked';
  }

  const resolver: ChannelAccessResolutionPort = {
    async resolveAccess(input, requester) {
      if (typeof currentAgent(requester.principal, requester.sessionGeneration) !== 'object') return { kind: 'unavailable' };
      let channelId: string | null = null;
      if (input.kind === 'listing_ref') {
        const target = listing.resolve({ principal: requester.principal, generation: requester.sessionGeneration }, input.listingRef);
        if (target !== 'unavailable') channelId = target.channelId;
      } else {
        // A canonical URL is a locator for any existing channel; it never bypasses the owner prompt.
        const url = new URL(input.channelUrl);
        channelId = url.origin === requester.origin ? CHANNEL_PATH.exec(url.pathname)?.[1] ?? null : null;
      }
      if (channelId === null) return { kind: 'unavailable' };
      const target = store.target(channelId);
      if (target.kind !== 'found') return { kind: 'unavailable' };
      return {
        kind: 'resolved',
        ownerId: human.ownerId,
        channelRef: `${input.kind === 'listing_ref' ? LISTED_PREFIX : ''}${channelId}` as AuthorizedChannelRef,
        targetRevision: `vis_${target.target.visibilityEpoch}`,
        title: target.target.title ?? 'Untitled channel',
      };
    },
    async resolveCreate(_input, requester) {
      return typeof currentAgent(requester.principal, requester.sessionGeneration) === 'object'
        ? { kind: 'resolved', ownerId: human.ownerId, ownerRevision: OWNER_REVISION }
        : { kind: 'unavailable' };
    },
    async revalidateAccess(input) {
      if (input.ownerId !== human.ownerId) return { kind: 'unavailable' };
      const agent = currentAgent(input.requester.principal, input.requester.sessionGeneration);
      if (agent === 'unavailable') return { kind: 'unavailable' };
      const { channelId, listed } = channelOf(input.channelRef);
      const target = store.target(channelId);
      if (target.kind === 'unavailable') return { kind: 'unavailable' };
      // Rebind, deletion and any visibility change close the request.
      if (agent === 'revoked' || target.kind === 'absent' || `vis_${target.target.visibilityEpoch}` !== input.targetRevision) {
        return { kind: 'revoked' };
      }
      // So does losing the eligibility a listing reference was issued under.
      if (listed) {
        const eligible = store.eligible(channelId, input.requester.principal);
        if (eligible === 'unavailable') return { kind: 'unavailable' };
        if (!eligible) return { kind: 'revoked' };
      }
      return { kind: 'current', ownerId: human.ownerId, targetRevision: input.targetRevision, title: target.target.title ?? 'Untitled channel' };
    },
    async revalidateCreate(input) {
      if (input.ownerId !== human.ownerId || input.ownerRevision !== OWNER_REVISION) return { kind: 'unavailable' };
      const agent = currentAgent(input.requester.principal, input.requester.sessionGeneration);
      if (agent === 'unavailable') return { kind: 'unavailable' };
      return agent === 'revoked' ? { kind: 'revoked' } : { kind: 'current', ownerId: human.ownerId, ownerRevision: OWNER_REVISION };
    },
    async currentAccessOwner(channelRef, principal) {
      if (principal.ownerId !== human.ownerId) return { kind: 'forbidden' };
      const target = store.target(channelOf(channelRef).channelId);
      if (target.kind === 'unavailable') return { kind: 'unavailable' };
      return target.kind === 'found'
        ? { kind: 'owned', ownerId: human.ownerId, targetRevision: `vis_${target.target.visibilityEpoch}` }
        : { kind: 'unavailable' };
    },
    async checkRequester(context) {
      const agent = currentAgent(context.principal, context.sessionGeneration);
      if (agent === 'unavailable') return { kind: 'unavailable' };
      return agent !== 'revoked' && agent.sessionDigest === context.sessionFingerprint ? { kind: 'current' } : { kind: 'revoked' };
    },
  };

  const journal = createChannelAccessStore({ store: deps.control, policy, clock });
  const access = createChannelAccessService({ store: journal, resolver, policy });

  const admission: ChannelAdmissionProviderPort = {
    async admit(input) {
      const request = admissionInput(input);
      if (request === null) return { kind: 'rejected' };
      return store.admit(request);
    },
    async reconcile(input) {
      const request = admissionInput(input);
      if (request === null) return { kind: 'rejected' };
      return store.reconcileAdmission(request);
    },
  };

  function admissionInput(input: ChannelAdmissionRequest) {
    if (input.ownerId !== human.ownerId || input.history !== 'none') return null;
    const agent = currentAgent(input.requester, input.sessionGeneration);
    if (typeof agent !== 'object') return null;
    return {
      providerOperationId: input.providerOperationId,
      channelId: channelOf(input.channelRef).channelId,
      ownerId: human.ownerId,
      participantId: agentParticipant(input.requester) as HumanAuthority['participantId'],
      deviceId: input.deviceId,
      displayName: agent.displayLabel ?? agent.harness,
    };
  }

  const exchange = createGrantExchangeService({
    store: deps.control,
    authority: createGrantExchangeAuthority({ store: journal, fulfillment: access.fulfillment, clock }),
    provider: admission,
    issuer: createExchangeGrantIssuer({ store: deps.control, clock }),
    clock,
  });

  const createAdapter: ChannelCreateAdapterPort = {
    async create(input) {
      const { workflow } = input;
      if (workflow.kind !== 'human_authorized_channel_create' || workflow.ownerId !== human.ownerId
        || clock() >= Date.parse(workflow.expiresAt)) {
        return { v: 1, idempotencyKey: input.idempotencyKey, outcome: 'unavailable', channelRef: null };
      }
      const created = store.createSecretChannel({
        idempotencyKey: input.idempotencyKey,
        channelId: deps.newChannelId(),
        title: input.intent.proposedTitle,
        ownerId: human.ownerId,
        creatorParticipantId: human.participantId,
        creatorDeviceId: human.deviceId,
        createdAt: new Date(clock()).toISOString(),
      });
      return reconciliation(input.idempotencyKey, created);
    },
    async reconcile(input) {
      if (input.workflow.ownerId !== human.ownerId) {
        return { v: 1, idempotencyKey: input.idempotencyKey, outcome: 'unavailable', channelRef: null };
      }
      const found = store.findSecretChannel(input.idempotencyKey);
      return found.kind === 'absent'
        ? { v: 1, idempotencyKey: input.idempotencyKey, outcome: 'pending', channelRef: null }
        : reconciliation(input.idempotencyKey, found);
    },
  };

  function requesterOf(agent: DiscoveryAgentContext, stored: DiscoveryAgent): DiscoveryRequester {
    return {
      principal: agent.principal as StableAgentPrincipal,
      origin: agent.origin,
      proofKey: { algorithm: 'Ed25519', publicKey: stored.proofPublicKey, thumbprint: stored.proofThumbprint },
      sessionGeneration: agent.generation,
    };
  }

  function contextOf(agent: DiscoveryAgentContext, stored: DiscoveryAgent): ChannelAccessRequesterContext {
    return {
      v: 1,
      principal: agent.principal as StableAgentPrincipal,
      origin: agent.origin,
      sessionGeneration: agent.generation,
      sessionFingerprint: stored.sessionDigest,
      harness: stored.harness,
      displayLabel: stored.displayLabel,
      workspaceLabel: stored.workspaceLabel,
    };
  }

  /** Every agent call rechecks that this exact generation is still the issued one. */
  function withAgent<T>(agent: DiscoveryAgentContext, operationId: string, run: (stored: DiscoveryAgent) => Promise<T>) {
    const stored = currentAgent(agent.principal, agent.generation);
    if (typeof stored !== 'object') return Promise.resolve({ v: 1 as const, operationId, outcome: 'unavailable' as const });
    return run(stored);
  }

  function settingsView(settings: Readonly<{ channelId: string; visibility: DiscoverySettingsView['visibility']; revision: number; allowlist: readonly string[] }>): DiscoverySettingsView {
    return { v: 1, channelId: settings.channelId, visibility: settings.visibility, revision: settings.revision, allowlist: settings.allowlist };
  }

  const isOwner = (principal: HumanAuthority) => principal.ownerId === human.ownerId;

  const port: InternalDiscoveryPort = {
    async authenticate(capability) {
      const found = store.agentByCapability(capabilityDigest(capability));
      if (found.kind === 'unavailable') return 'unavailable';
      if (found.kind === 'absent') return null;
      return { principal: found.agent.principal, generation: found.agent.generation, proofThumbprint: found.agent.proofThumbprint };
    },

    async issue(input) {
      const capability = randomBytes(CAPABILITY_BYTES).toString('base64url');
      const principal = discoveryPrincipal(input.harness, input.sessionId);
      const issued = store.issueAgent({
        principal,
        harness: input.harness,
        sessionDigest: digest('session', input.harness, input.sessionId),
        displayLabel: input.displayLabel,
        workspaceLabel: input.workspaceLabel,
        capabilityDigest: capabilityDigest(capability),
        proofPublicKey: input.proofPublicKey,
        proofThumbprint: ed25519Thumbprint(input.proofPublicKey),
        issuedAt: new Date(clock()).toISOString(),
      });
      if (issued.kind !== 'issued') return issued;
      return { kind: 'issued', principal, generation: issued.agent.generation, discoveryCapability: capability };
    },

    async list(agent, cursor) {
      if (typeof currentAgent(agent.principal, agent.generation) !== 'object') return { kind: 'unavailable' };
      return listing.list({ principal: agent.principal, generation: agent.generation }, cursor);
    },

    requestAccess: (agent, request) => withAgent(agent, request.operationId,
      stored => access.journal.requestAccess(request, requesterOf(agent, stored), contextOf(agent, stored))),

    requestCreate: (agent, intent) => withAgent(agent, intent.operationId,
      stored => access.journal.requestCreate(intent, requesterOf(agent, stored), contextOf(agent, stored))),

    status: (agent, query) => withAgent(agent, query.operationId,
      stored => access.journal.inspect(query, requesterOf(agent, stored), contextOf(agent, stored))),

    async exchange(agent, operationId, request) {
      const stored = currentAgent(agent.principal, agent.generation);
      if (typeof stored !== 'object') return { kind: 'rejected', code: 'closed' };
      const validated = await validateGrantExchangeRequest(request, {
        operationId,
        requester: agent.principal as StableAgentPrincipal,
        origin: agent.origin,
        sessionGeneration: agent.generation,
        // The connector reserves its device locally; the proof key it signed with is the authority.
        deviceId: request.deviceId,
        proofKeyThumbprint: stored.proofThumbprint,
        nowMs: clock(),
      });
      if (!validated.ok) return { kind: 'rejected', code: validated.reason };
      return exchange.forConnector({ sessionFingerprint: stored.sessionDigest }).exchange(validated.request);
    },

    async acknowledge(agent, operationId, readiness) {
      const stored = currentAgent(agent.principal, agent.generation);
      if (typeof stored !== 'object') return { kind: 'rejected', code: 'closed' };
      // Every asserted field must match the authenticated connector; the proof key signed this request.
      if (readiness.operationId !== operationId) return { kind: 'rejected', code: 'operation_mismatch' };
      if (readiness.requester !== agent.principal) return { kind: 'rejected', code: 'wrong_requester' };
      if (readiness.origin !== agent.origin) return { kind: 'rejected', code: 'wrong_origin' };
      if (readiness.sessionGeneration !== agent.generation) return { kind: 'rejected', code: 'wrong_generation' };
      if (readiness.proofKeyThumbprint !== stored.proofThumbprint) return { kind: 'rejected', code: 'proof_mismatch' };
      return exchange.forConnector({ sessionFingerprint: stored.sessionDigest }).acknowledge(readiness);
    },

    async inbox(principal) {
      if (!isOwner(principal)) return [];
      const result = await access.decisions.inbox(owner);
      return result.kind === 'ok' ? result.value : 'unavailable';
    },

    async decide(principal, command, kind) {
      if (!isOwner(principal)) return { kind: 'rejected', code: 'forbidden' };
      const listed = await access.decisions.inbox(owner);
      if (listed.kind !== 'ok') return { kind: 'unavailable', retryable: true };
      const request = listed.value.find(entry => entry.requestHandle === command.requestHandle);
      // The route names the operation kind; a mismatched handle is simply not found there.
      if (request && request.operationKind !== kind) return { kind: 'rejected', code: 'not_found' };
      return access.decisions.decide(command, owner);
    },

    async mute(principal, command) {
      if (!isOwner(principal)) return { kind: 'rejected', code: 'forbidden' };
      return access.decisions.setMute(command, owner);
    },

    async settings(principal, channelId) {
      if (!isOwner(principal)) return 'not_found';
      const result = store.settings(channelId);
      if (result.kind === 'unavailable') return 'unavailable';
      return result.kind === 'not_found' ? 'not_found' : settingsView(result.settings);
    },

    async updateSettings(principal, channelId, mutation) {
      if (!isOwner(principal)) return { kind: 'rejected', code: 'not_found' };
      const result = store.updateSettings({ channelId, ...mutation });
      if (result.kind === 'unavailable') return { kind: 'outcome_unknown', operationId: mutation.operationId };
      return result.kind === 'done' ? { kind: 'ok', value: settingsView(result.settings) } : { kind: 'rejected', code: result.code };
    },

    async agents(principal) {
      if (!isOwner(principal)) return [];
      const result = store.listAgents();
      if (result.kind !== 'done') return 'unavailable';
      return result.agents.map((agent): DiscoveryAgentView => ({
        v: 1,
        principal: agent.principal,
        fingerprint: agent.sessionDigest,
        generation: agent.generation,
        harness: agent.harness,
        displayLabel: agent.displayLabel,
        workspaceLabel: agent.workspaceLabel,
        issuedAt: agent.issuedAt,
      }));
    },
  };

  return { port, createAdapter, admission };
}

function reconciliation(
  idempotencyKey: string,
  result: ReturnType<DiscoveryStore['createSecretChannel']>,
): ChannelCreateReconciliation {
  if (result.kind === 'created' || result.kind === 'already_created') {
    return { v: 1, idempotencyKey, outcome: result.kind, channelRef: result.channelId as unknown as AuthorizedChannelRef };
  }
  return { v: 1, idempotencyKey, outcome: result.kind === 'unavailable' ? 'outcome_unknown' : 'unavailable', channelRef: null };
}
