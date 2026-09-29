// Hosted resume-by-operation for the channel-access exchange. A connector that crashed
// or failed activation after its grant was redeemed finishes the same operation here,
// without a grant. Nothing is minted or admitted: the service only re-checks that the
// operation was admitted and is still inside its recovery window, that the caller holds
// the key the exchange was bound to, and that owner approval and ownership still hold,
// and then returns the binding created at redemption with a fresh adapter capability.
// Any doubt is a refusal, and a lost race or store fault is `unavailable`.

import type {
  CallOptions,
  DeviceId,
  GrantExchangeRejection,
  OperationResult,
  SessionBinding,
  StableAgentPrincipal,
  TrustedClock,
} from '@khala/contracts/messaging/index';
import type { AdapterAction, AdapterCapabilities } from '../../agent-bootstrap/handler';
import type { GrantExchangeAuthority } from '@khala/messaging/channel-access/exchange/authority';
import type { ExchangeGrantIssuer } from '@khala/messaging/channel-access/exchange/grants';
import { findChannelAccessBinding } from './channel-access-binding';
import type { ControlStore } from '@khala/contracts/messaging/index';

/** The part of the exchange record resume reads; the composition root supplies the journal. */
export type ResumableExchange = Readonly<{
  operationId: string;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  sessionFingerprint: string;
  deviceId: DeviceId;
  proofKeyThumbprint: string;
  providerOperationId: string;
  expiresAt: string;
  phase: 'bound' | 'admitting' | 'admitted' | 'sealed' | 'acknowledged' | 'closed';
  closed: 'expired' | 'closed' | null;
}>;

export type ChannelAccessResumeJournal = Readonly<{
  load(
    identity: Readonly<{ requester: string; origin: string; operationId: string }>,
    options?: CallOptions,
  ): Promise<
    | Readonly<{ kind: 'absent' | 'unavailable' }>
    | Readonly<{ kind: 'found'; stored: Readonly<{ key: string; record: ResumableExchange }> }>
  >;
}>;

export type ChannelAccessResumeRequest = Readonly<{
  v: 1;
  operationId: string;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  deviceId: DeviceId;
  bindingId?: string;
  /** Must be the thumbprint of the key the exchange was bound to. */
  proofKeyThumbprint: string;
}>;

export type ResumedChannelAccess = Readonly<{
  binding: SessionBinding;
  capability: Readonly<{ token: string; scope: readonly AdapterAction[]; expiresAt: number }>;
}>;

export type ChannelAccessResumeResult = OperationResult<ResumedChannelAccess, GrantExchangeRejection>;

export type ChannelAccessResumeService = Readonly<{
  /** Request-scoped resume for one authenticated connector. */
  forConnector(connector: Readonly<{ sessionFingerprint: string }>): Readonly<{
    resume(input: ChannelAccessResumeRequest, options?: CallOptions): Promise<ChannelAccessResumeResult>;
  }>;
}>;

export function createChannelAccessResumeService(deps: Readonly<{
  journal: ChannelAccessResumeJournal;
  authority: GrantExchangeAuthority;
  issuer: Pick<ExchangeGrantIssuer, 'wasRedeemed'>;
  bindings: Pick<AdapterCapabilities, 'resumeAdapterCapability'>;
  store: ControlStore;
  approval?: (record: ResumableExchange, ownerId: string, channelRef: string) => Promise<'current' | 'revoked' | 'unavailable'>;
  clock: TrustedClock;
}>): ChannelAccessResumeService {
  const { journal } = deps;

  async function resume(
    input: ChannelAccessResumeRequest,
    connector: Readonly<{ sessionFingerprint: string }>,
    options?: CallOptions,
  ): Promise<ChannelAccessResumeResult> {
    const loaded = await journal.load(input, options);
    if (loaded.kind === 'unavailable') return unavailable();
    if (loaded.kind !== 'found') return rejected('operation_mismatch');
    const { key, record } = loaded.stored;
    if (record.sessionGeneration !== input.sessionGeneration) return rejected('wrong_generation');
    if (record.deviceId !== input.deviceId) return rejected('wrong_device');
    // Proof of possession: the request is only as good as the key the exchange was bound to.
    if (record.proofKeyThumbprint !== input.proofKeyThumbprint) return rejected('proof_mismatch');
    if (record.sessionFingerprint !== connector.sessionFingerprint) return rejected('operation_mismatch');
    if (record.phase === 'closed') return rejected(record.closed!);
    // Acknowledged means the connector is already connected; nothing is left to resume.
    if (record.phase === 'acknowledged') return rejected('closed');
    if (record.phase !== 'sealed') return rejected('operation_mismatch');
    if (deps.clock() >= Date.parse(record.expiresAt)) return rejected('expired');

    // Only an operation whose grant was actually redeemed was admitted and has a binding.
    const redeemed = await safe(() => deps.issuer.wasRedeemed(record, options));
    if (redeemed === null || redeemed === 'unavailable') return unavailable();
    if (redeemed === 'never') return rejected('operation_mismatch');

    const authority = await safe(() => deps.authority.authorize({
      operationId: record.operationId,
      requester: record.requester,
      origin: record.origin,
      sessionGeneration: record.sessionGeneration,
      sessionFingerprint: record.sessionFingerprint,
      claimOperationId: `${key}#claim`,
    }, options));
    if (authority === null || authority.kind === 'unavailable') return unavailable();
    if (authority.kind === 'closed') return rejected(authority.reason);
    const authorization = authority.authorization;
    if (authorization.kind !== 'access' || authorization.operationId !== record.operationId
      || authorization.requester !== record.requester || authorization.origin !== record.origin
      || authorization.sessionGeneration !== record.sessionGeneration
      || authorization.sessionFingerprint !== record.sessionFingerprint) return rejected('closed');
    if (deps.clock() >= Date.parse(authorization.deadline)) return rejected('expired');

    const mapped = await safe(() => findChannelAccessBinding(deps.store, record));
    if (mapped === null || mapped.kind === 'unavailable') return unavailable();
    if (mapped.kind !== 'found') return rejected('operation_mismatch');
    const issued = mapped.value.operation;
    if (issued.sessionGeneration !== record.sessionGeneration || issued.deviceId !== record.deviceId
      || issued.proofKeyThumbprint !== record.proofKeyThumbprint || issued.ownerId !== authorization.ownerId
      || issued.channelRef !== authorization.channelRef || (input.bindingId && input.bindingId !== mapped.value.bindingId)) {
      return rejected('operation_mismatch');
    }
    const currentApproval = deps.approval;
    if (currentApproval) {
      const approval = await safe(() => currentApproval(record, authorization.ownerId, authorization.channelRef));
      if (approval === null || approval === 'unavailable') return unavailable();
      if (approval !== 'current') return rejected('closed');
    }
    const bindingId = mapped.value.bindingId;

    const resumed = await safe(() => deps.bindings.resumeAdapterCapability({
      bindingId,
      ownerId: authorization.ownerId,
      deviceId: record.deviceId,
      generation: record.sessionGeneration,
      jkt: record.proofKeyThumbprint,
      expectedSession: { harness: 'proof-key', sessionId: record.requester },
    }));
    if (resumed === null || resumed.kind === 'unavailable') return unavailable();
    if (resumed.kind === 'refused') return rejected(resumed.code === 'binding_revoked' ? 'closed' : 'operation_mismatch');
    if (resumed.binding.bindingId !== bindingId || resumed.binding.harness !== 'proof-key'
      || resumed.binding.sessionId !== record.requester || resumed.binding.generation !== record.sessionGeneration
      || resumed.binding.deviceId !== record.deviceId) return rejected('operation_mismatch');
    return { kind: 'ok', value: { binding: resumed.binding, capability: resumed.capability } };
  }

  return Object.freeze({
    forConnector: connector => Object.freeze({
      resume: (input: ChannelAccessResumeRequest, options?: CallOptions) => resume(input, connector, options),
    }),
  });
}

function rejected(code: GrantExchangeRejection): ChannelAccessResumeResult {
  return { kind: 'rejected', code };
}

function unavailable(): ChannelAccessResumeResult {
  return { kind: 'unavailable', retryable: true };
}

async function safe<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}
