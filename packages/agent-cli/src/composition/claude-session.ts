import type {
  BindingId, HarnessCapabilities, ListeningMode, ListeningModeResult, SessionBinding,
} from '@khala/contracts/delivery/index';
import type { AgentListeningModeReadResult } from '@khala/connector/agent/listening-mode';
import { CliError } from '../cli/errors.js';
import type { InboxBatch } from '../cli/inbox.js';
import type { SendResult } from '../cli/types.js';
import { validIdentifier } from '../cli/validation.js';
import type { ReadOperationPort } from '../mcp/read-tool.js';
import { renderInboxBatchWithoutToken } from '../mcp/result-postprocessor.js';

export const CLAUDE_SESSION_HARNESS = 'claude';

/** The installation the setup-managed credential authenticated. */
export type ClaudePrincipal = Readonly<{ principalId: string }>;

export type ClaudeSessionClaim = Readonly<{ harness: typeof CLAUDE_SESSION_HARNESS; sessionId: string }>;

/** Server-side: authenticates the setup-managed installation credential. */
export interface ClaudeInstallationAuthenticator {
  authenticate(credential: string): Promise<ClaudePrincipal | null>;
}

/**
 * Server-side: authorizes a Claude session ID as a selector for one of this
 * principal's verified bindings, returning its active generation. A session the
 * principal does not own resolves exactly like one that does not exist.
 */
export interface ClaudeSessionDirectory {
  resolve(principal: ClaudePrincipal, claim: ClaudeSessionClaim): Promise<SessionBinding | null>;
}

/** Retained batch tokens belong to one principal's binding; each is scoped to one generation. */
export type SessionScope = Readonly<{ principalId: string; bindingId: BindingId }>;

/** A token a hook pull or agent read delivered and no agent call has acknowledged yet. */
export type RetainedToken = Readonly<{ generation: number; token: string }>;

/**
 * A trusted Khala call's result, the retained tokens it committed (acknowledged or
 * fenced), and the token of a batch it delivered, if any.
 */
export type EnvelopeStep<T> = Readonly<{ value: T; committed: readonly RetainedToken[]; retain: RetainedToken | null }>;

/** At most this many generations keep a token; older ones are fenced anyway. */
export const MAX_RETAINED = 8;

/**
 * Implemented by the authenticated local Khala server, never by a hook or command
 * process. `envelope` linearizes calls per scope and hands each call every retained
 * token. It clears only the tokens the call reports committed, and only after the
 * call resolves, then retains the token of any batch the call delivered. A call
 * that throws changes nothing, so its tokens are carried again next time.
 */
export interface ClaudeSessionStatePort {
  envelope<T>(scope: SessionScope, call: (retained: readonly RetainedToken[]) => Promise<EnvelopeStep<T>>): Promise<T>;
}

/** The retained set after a call: committed tokens removed, a delivered token replacing its generation's. */
export function nextRetained(retained: readonly RetainedToken[], step: EnvelopeStep<unknown>): readonly RetainedToken[] {
  const kept = retained.filter(entry => !step.committed.some(done => done.generation === entry.generation && done.token === entry.token));
  if (step.retain === null) return kept;
  const merged = [...kept.filter(entry => entry.generation !== step.retain!.generation), step.retain];
  return merged.sort((x, y) => x.generation - y.generation).slice(-MAX_RETAINED);
}

export type ModeSetInput = Readonly<{
  commandId: string; expectedVersion: number; requested: ListeningMode; issuedAt: string; acknowledgeToken?: string;
}>;

/** A token-bearing call's result and the piggyback batch it selected, if any. */
export type PiggybackStep<T> = Readonly<{ value: T; batch: InboxBatch | null }>;

/**
 * The shared application operations for one verified binding. `read` is the single
 * `khala_read` operation; send and mode control carry the prior token through the
 * shared contract and may select a piggyback batch. None of them is Claude-specific.
 */
export type ClaudeBindingServices = Readonly<{
  read: ReadOperationPort;
  send(input: Readonly<{ body: string; acknowledgeToken?: string }>): Promise<PiggybackStep<SendResult>>;
  setMode(input: ModeSetInput): Promise<PiggybackStep<ListeningModeResult>>;
  readMode(): Promise<AgentListeningModeReadResult>;
  capabilities(): Promise<HarnessCapabilities>;
  /**
   * `local-automation-fence`'s notification-only pending signal. It carries no
   * release bytes or token and never pulls, moves a cursor, or acknowledges.
   */
  pending(): Promise<Readonly<{ pending: boolean }>>;
}>;

export type ClaudeSessionAdapterOptions = Readonly<{
  authenticator: ClaudeInstallationAuthenticator;
  sessions: ClaudeSessionDirectory;
  state: ClaudeSessionStatePort;
  services(binding: SessionBinding): ClaudeBindingServices;
}>;

export const CLAUDE_SESSION_REFUSALS = [
  'invalid_request', 'unauthorized', 'session_not_bound', 'binding_not_held', 'unproven', 'unavailable',
] as const;
export type ClaudeSessionRefusal = Readonly<{ kind: 'refused'; code: (typeof CLAUDE_SESSION_REFUSALS)[number] }>;

export type ClaudeSessionCall = Readonly<{ credential: string; sessionId: string }>;

export type ClaudeReadOutcome = Readonly<{ kind: 'batch'; text: string }> | Readonly<{ kind: 'empty' }> | ClaudeSessionRefusal;
/** A piggyback batch, rendered without its token, delivered alongside a send or mode change. */
type Piggyback = Readonly<{ batch?: string }>;
export type ClaudeSendOutcome =
  | (Readonly<{ kind: 'accepted'; clientTxnId: string; eventId: string | null }> & Piggyback)
  | (Readonly<{ kind: 'refused'; code: string; clientTxnId: string }> & Piggyback)
  | (Readonly<{ kind: 'outcome_unknown'; clientTxnId: string }> & Piggyback)
  | ClaudeSessionRefusal;
export type ClaudeModeOutcome = Readonly<{
  kind: 'mode';
  requested: ListeningMode;
  effective: ListeningMode | null;
  version: number;
  support: Readonly<Record<ListeningMode, string>>;
  acknowledgement: HarnessCapabilities['acknowledgement'];
}> | ClaudeSessionRefusal;
export type ClaudeModeSetOutcome = (Readonly<{
  kind: 'mode_set';
  outcome: ListeningModeResult['outcome'];
  requested: ListeningMode;
  effective: ListeningMode | null;
  version: number;
}> & Piggyback) | ClaudeSessionRefusal;
export type ClaudePendingOutcome = Readonly<{ kind: 'pending' | 'idle' }> | ClaudeSessionRefusal;
/** Content-free: how many retained batch tokens this call committed, and nothing else. */
export type ClaudeStatusOutcome = Readonly<{ kind: 'status'; acknowledged: number }> | ClaudeSessionRefusal;

/**
 * Two kinds of caller. Hook pulls (`PostToolUse`, `Stop`, the watcher) deliver a
 * batch and retain its token but never acknowledge. Agent-initiated calls
 * (`khala_read`, `khala_send`, `khala_status`, mode calls) acknowledge every
 * retained token. `pending` is notification only and does neither.
 */
export interface ClaudeSessionAdapter {
  pull(call: ClaudeSessionCall, input: Readonly<{ maxBytes: number }>): Promise<ClaudeReadOutcome>;
  read(call: ClaudeSessionCall, input: Readonly<{ maxBytes: number }>): Promise<ClaudeReadOutcome>;
  send(call: ClaudeSessionCall, input: Readonly<{ body: string }>): Promise<ClaudeSendOutcome>;
  status(call: ClaudeSessionCall): Promise<ClaudeStatusOutcome>;
  mode(call: ClaudeSessionCall): Promise<ClaudeModeOutcome>;
  setMode(call: ClaudeSessionCall, input: Omit<ModeSetInput, 'acknowledgeToken'>): Promise<ClaudeModeSetOutcome>;
  pending(call: ClaudeSessionCall): Promise<ClaudePendingOutcome>;
}

type Resolved = Readonly<{ binding: SessionBinding; scope: SessionScope; services: ClaudeBindingServices }>;

/** What an agent call did with the current generation's retained token. */
type AgentStep<T> = Readonly<{ value: T; carried: boolean; delivered: string | null }>;

const refused = (code: ClaudeSessionRefusal['code']): ClaudeSessionRefusal => ({ kind: 'refused', code });

/**
 * The server-side Claude session adapter. Every call authenticates the installation
 * credential, then treats the Claude session ID only as a selector among that
 * principal's verified bindings; cwd plays no part. Reads delegate to the single
 * `khala_read` operation, and every token-bearing call runs inside the state port's
 * envelope. Tokens never leave this adapter: outcomes carry no token, and refusals
 * carry only a closed code.
 *
 * The shared inbox keeps at most one outstanding batch per binding and generation
 * and replays it until acknowledged, so a hook pull that repeats before the agent
 * acts simply sees the same batch again.
 */
export function createClaudeSessionAdapter(options: ClaudeSessionAdapterOptions): ClaudeSessionAdapter {
  async function resolve(call: ClaudeSessionCall): Promise<Resolved | ClaudeSessionRefusal> {
    if (typeof call.credential !== 'string' || !validIdentifier(call.sessionId)) return refused('invalid_request');
    const principal = await options.authenticator.authenticate(call.credential);
    if (principal === null) return refused('unauthorized');
    const binding = await options.sessions.resolve(principal, { harness: CLAUDE_SESSION_HARNESS, sessionId: call.sessionId });
    // Defence in depth: a directory that answers with another session's binding is refused.
    if (binding === null || binding.harness !== CLAUDE_SESSION_HARNESS || binding.sessionId !== call.sessionId) {
      return refused('session_not_bound');
    }
    return {
      binding,
      scope: { principalId: principal.principalId, bindingId: binding.bindingId },
      services: options.services(binding),
    };
  }

  async function handoff(resolved: Resolved): Promise<boolean> {
    const capabilities = await resolved.services.capabilities();
    return capabilities.harness === CLAUDE_SESSION_HARNESS && capabilities.acknowledgement === 'batch_token_next_call';
  }

  /** One `readBatch` call that carries `token`; any batch it selects stays outstanding and replays. */
  async function acknowledgeOnly(services: ClaudeBindingServices, bindingId: BindingId, token: string): Promise<void> {
    await services.read.read({ bindingId, maxBytes: 0, acknowledgeToken: token });
  }

  /**
   * Runs an agent-initiated call. Every retained token from another generation is
   * acknowledged by its own `readBatch` call first; one whose generation was
   * replaced is fenced and dropped, and its release requeues upstream. The current
   * generation's token rides on the call itself. Tokens are committed only after
   * their call resolves.
   */
  async function agentCall<T>(
    resolved: Resolved,
    run: (current: string | undefined) => Promise<AgentStep<T>>,
  ): Promise<Readonly<{ value: T; acknowledged: number }>> {
    const generation = resolved.binding.generation;
    return options.state.envelope(resolved.scope, async retained => {
      const committed: RetainedToken[] = [];
      for (const entry of retained) {
        if (entry.generation === generation) continue;
        try {
          await acknowledgeOnly(options.services({ ...resolved.binding, generation: entry.generation }), resolved.binding.bindingId, entry.token);
          committed.push(entry);
        } catch (error) {
          if (error instanceof CliError && error.code === 'binding_not_held') committed.push(entry);
          // Anything else keeps the token for the next agent call.
        }
      }
      const current = retained.find(entry => entry.generation === generation);
      const step = await run(current?.token);
      if (current !== undefined && step.carried) committed.push(current);
      return {
        value: { value: step.value, acknowledged: committed.length },
        committed,
        retain: step.delivered === null ? null : { generation, token: step.delivered },
      };
    });
  }

  return {
    async pull(call, input) {
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) return refused('invalid_request');
      return guarded(async () => {
        const resolved = await resolve(call);
        if ('kind' in resolved) return resolved;
        // Without batch-token handoff a pulled batch could never be acknowledged.
        if (!await handoff(resolved)) return refused('unproven');
        const generation = resolved.binding.generation;
        return options.state.envelope<ClaudeReadOutcome>(resolved.scope, async () => {
          // A hook pull never acknowledges: no token rides on it, whatever is retained.
          const read = await resolved.services.read.read({ bindingId: resolved.binding.bindingId, maxBytes: input.maxBytes });
          if (read.kind === 'empty') return { value: { kind: 'empty' } as const, committed: [], retain: null };
          // Render before the token is retained: a batch that cannot be delivered is never retained.
          const text = renderInboxBatchWithoutToken(read.batch);
          return { value: { kind: 'batch', text } as const, committed: [], retain: { generation, token: read.batch.token } };
        });
      });
    },

    async read(call, input) {
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) return refused('invalid_request');
      return guarded(async () => {
        const resolved = await resolve(call);
        if ('kind' in resolved) return resolved;
        if (!await handoff(resolved)) return refused('unproven');
        const { value } = await agentCall<ClaudeReadOutcome>(resolved, async current => {
          const read = await resolved.services.read.read({
            bindingId: resolved.binding.bindingId,
            maxBytes: input.maxBytes,
            ...(current === undefined ? {} : { acknowledgeToken: current }),
          });
          if (read.kind === 'empty') return { value: { kind: 'empty' }, carried: true, delivered: null };
          return { value: { kind: 'batch', text: renderInboxBatchWithoutToken(read.batch) }, carried: true, delivered: read.batch.token };
        });
        return value;
      });
    },

    async send(call, input) {
      return guarded(async () => {
        const resolved = await resolve(call);
        if ('kind' in resolved) return resolved;
        const { value: result, batch } = await tokenBearing(resolved, current => resolved.services.send({
          body: input.body, ...(current === undefined ? {} : { acknowledgeToken: current }),
        }), result => result.kind === 'accepted');
        const piggyback = batch === null ? {} : { batch };
        if (result.kind === 'accepted') return { kind: 'accepted', clientTxnId: result.clientTxnId, eventId: result.eventId, ...piggyback };
        if (result.kind === 'refused') return { kind: 'refused', code: result.code, clientTxnId: result.clientTxnId, ...piggyback };
        return { kind: 'outcome_unknown', clientTxnId: result.clientTxnId, ...piggyback };
      });
    },

    async status(call) {
      return guarded(async () => {
        const resolved = await resolve(call);
        if ('kind' in resolved) return resolved;
        if (!await handoff(resolved)) return { kind: 'status', acknowledged: 0 };
        const { acknowledged } = await agentCall(resolved, acknowledgeCurrent(resolved));
        return { kind: 'status', acknowledged };
      });
    },

    async mode(call) {
      return guarded(async () => {
        const resolved = await resolve(call);
        if ('kind' in resolved) return resolved;
        const [view, capabilities] = await Promise.all([resolved.services.readMode(), resolved.services.capabilities()]);
        if (!view.ok) return refused(view.code === 'unavailable' ? 'unavailable' : 'binding_not_held');
        // A mode read is agent-initiated too, so it acknowledges what hooks delivered.
        if (capabilities.harness === CLAUDE_SESSION_HARNESS && capabilities.acknowledgement === 'batch_token_next_call') {
          await agentCall(resolved, acknowledgeCurrent(resolved));
        }
        // Effective support comes from HarnessCapabilities; anything unevidenced stays unproven.
        const support = Object.fromEntries((['steer', 'sync', 'async'] as const).map(mode => [
          mode, capabilities.harness === CLAUDE_SESSION_HARNESS ? publicSupport(capabilities.modes[mode].status) : 'unproven',
        ])) as Record<ListeningMode, string>;
        return {
          kind: 'mode',
          requested: view.view.requested,
          effective: view.view.effective,
          version: view.view.version,
          support,
          acknowledgement: capabilities.acknowledgement,
        };
      });
    },

    async setMode(call, input) {
      return guarded(async () => {
        const resolved = await resolve(call);
        if ('kind' in resolved) return resolved;
        const { value: result, batch } = await tokenBearing(resolved, current => resolved.services.setMode({
          commandId: input.commandId,
          expectedVersion: input.expectedVersion,
          requested: input.requested,
          issuedAt: input.issuedAt,
          ...(current === undefined ? {} : { acknowledgeToken: current }),
        }), () => true);
        return {
          kind: 'mode_set', outcome: result.outcome, requested: result.requested, effective: result.effective, version: result.version,
          ...(batch === null ? {} : { batch }),
        };
      });
    },

    async pending(call) {
      return guarded(async () => {
        const resolved = await resolve(call);
        if ('kind' in resolved) return resolved;
        // Notification only: no state-port envelope, no read, and nothing but one bit out.
        const signal = await resolved.services.pending();
        return { kind: signal.pending === true ? 'pending' : 'idle' };
      });
    },
  };

  function acknowledgeCurrent(resolved: Resolved) {
    return async (current: string | undefined): Promise<AgentStep<null>> => {
      if (current !== undefined) await acknowledgeOnly(resolved.services, resolved.binding.bindingId, current);
      return { value: null, carried: true, delivered: null };
    };
  }

  async function tokenBearing<T>(
    resolved: Resolved,
    call: (current: string | undefined) => Promise<PiggybackStep<T>>,
    committedBy: (value: T) => boolean,
  ): Promise<Readonly<{ value: T; batch: string | null }>> {
    // Only `batch_token_next_call` permits retained-token handoff; otherwise the call
    // runs bare and its piggyback batch is neither shown nor retained, so it replays.
    if (!await handoff(resolved)) return { value: (await call(undefined)).value, batch: null };
    const { value } = await agentCall(resolved, async current => {
      const step = await call(current);
      const text = step.batch === null ? null : renderOrNull(step.batch);
      // The token is retained only when its batch is actually delivered with the result;
      // an unrenderable batch is dropped without hiding the call's own outcome.
      return {
        value: { value: step.value, batch: text },
        carried: committedBy(step.value),
        delivered: text === null ? null : step.batch!.token,
      };
    });
    return value;
  }
}

function renderOrNull(batch: InboxBatch): string | null {
  try { return renderInboxBatchWithoutToken(batch); } catch { return null; }
}

function publicSupport(status: string): string {
  return status === 'unknown' ? 'unproven' : status;
}

async function guarded<T>(run: () => Promise<T | ClaudeSessionRefusal>): Promise<T | ClaudeSessionRefusal> {
  try {
    return await run();
  } catch (error) {
    // Never forward error text: it could carry a token or payload.
    if (error instanceof CliError && error.code === 'binding_not_held') return refused('binding_not_held');
    if (error instanceof CliError && (error.code === 'invalid_input' || error.code === 'invalid_arguments')) {
      return refused('invalid_request');
    }
    return refused('unavailable');
  }
}
