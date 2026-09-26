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

/** Retained batch tokens are scoped to exactly this triple. */
export type BatchTokenScope = Readonly<{ principalId: string; bindingId: BindingId; generation: number }>;

/** A trusted Khala call's result and the batch token it returned, if any. */
export type EnvelopeStep<T> = Readonly<{ value: T; batchToken: string | null }>;

/**
 * Implemented by the authenticated local Khala server, never by a hook or command
 * process. `envelope` linearizes calls per scope: it takes the retained token (so it
 * is attached to exactly one call), runs the call with it, and durably stores any
 * token the call returned. A failed call attaches the token once and stores none;
 * the shared batch contract then replays the batch.
 */
export interface ClaudeSessionStatePort {
  envelope<T>(scope: BatchTokenScope, call: (retained: string | undefined) => Promise<EnvelopeStep<T>>): Promise<T>;
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

export interface ClaudeSessionAdapter {
  read(call: ClaudeSessionCall, input: Readonly<{ maxBytes: number }>): Promise<ClaudeReadOutcome>;
  send(call: ClaudeSessionCall, input: Readonly<{ body: string }>): Promise<ClaudeSendOutcome>;
  mode(call: ClaudeSessionCall): Promise<ClaudeModeOutcome>;
  setMode(call: ClaudeSessionCall, input: Omit<ModeSetInput, 'acknowledgeToken'>): Promise<ClaudeModeSetOutcome>;
  pending(call: ClaudeSessionCall): Promise<ClaudePendingOutcome>;
}

type Resolved = Readonly<{ binding: SessionBinding; scope: BatchTokenScope; services: ClaudeBindingServices }>;

const refused = (code: ClaudeSessionRefusal['code']): ClaudeSessionRefusal => ({ kind: 'refused', code });

/**
 * The server-side Claude session adapter. Every call authenticates the installation
 * credential, then treats the Claude session ID only as a selector among that
 * principal's verified bindings; cwd plays no part. Reads delegate to the single
 * `khala_read` operation, and every token-bearing call runs inside the state port's
 * envelope. Tokens never leave this adapter: outcomes carry no token, and refusals
 * carry only a closed code.
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
      scope: { principalId: principal.principalId, bindingId: binding.bindingId, generation: binding.generation },
      services: options.services(binding),
    };
  }

  async function handoff(resolved: Resolved): Promise<boolean> {
    const capabilities = await resolved.services.capabilities();
    return capabilities.harness === CLAUDE_SESSION_HARNESS && capabilities.acknowledgement === 'batch_token_next_call';
  }

  return {
    async read(call, input) {
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) return refused('invalid_request');
      return guarded(async () => {
        const resolved = await resolve(call);
        if ('kind' in resolved) return resolved;
        // Without batch-token handoff a pulled batch could never be acknowledged.
        if (!await handoff(resolved)) return refused('unproven');
        return options.state.envelope<ClaudeReadOutcome>(resolved.scope, async retained => {
          const read = await resolved.services.read.read({
            bindingId: resolved.binding.bindingId,
            maxBytes: input.maxBytes,
            ...(retained === undefined ? {} : { acknowledgeToken: retained }),
          });
          if (read.kind === 'empty') return { value: { kind: 'empty' } as const, batchToken: null };
          // Render before the token is stored: a batch that cannot be delivered is never retained.
          return { value: { kind: 'batch', text: renderInboxBatchWithoutToken(read.batch) } as const, batchToken: read.batch.token };
        });
      });
    },

    async send(call, input) {
      return guarded(async () => {
        const resolved = await resolve(call);
        if ('kind' in resolved) return resolved;
        const { value: result, batch } = await tokenBearing(resolved, retained => resolved.services.send({
          body: input.body, ...(retained === undefined ? {} : { acknowledgeToken: retained }),
        }));
        const piggyback = batch === null ? {} : { batch };
        if (result.kind === 'accepted') return { kind: 'accepted', clientTxnId: result.clientTxnId, eventId: result.eventId, ...piggyback };
        if (result.kind === 'refused') return { kind: 'refused', code: result.code, clientTxnId: result.clientTxnId, ...piggyback };
        return { kind: 'outcome_unknown', clientTxnId: result.clientTxnId, ...piggyback };
      });
    },

    async mode(call) {
      return guarded(async () => {
        const resolved = await resolve(call);
        if ('kind' in resolved) return resolved;
        const [view, capabilities] = await Promise.all([resolved.services.readMode(), resolved.services.capabilities()]);
        if (!view.ok) return refused(view.code === 'unavailable' ? 'unavailable' : 'binding_not_held');
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
        const { value: result, batch } = await tokenBearing(resolved, retained => resolved.services.setMode({
          commandId: input.commandId,
          expectedVersion: input.expectedVersion,
          requested: input.requested,
          issuedAt: input.issuedAt,
          ...(retained === undefined ? {} : { acknowledgeToken: retained }),
        }));
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

  async function tokenBearing<T>(
    resolved: Resolved,
    call: (retained: string | undefined) => Promise<PiggybackStep<T>>,
  ): Promise<Readonly<{ value: T; batch: string | null }>> {
    // Only `batch_token_next_call` permits retained-token handoff; otherwise the call
    // runs bare and its piggyback batch is neither shown nor retained, so it replays.
    if (!await handoff(resolved)) return { value: (await call(undefined)).value, batch: null };
    return options.state.envelope(resolved.scope, async retained => {
      const step = await call(retained);
      const text = step.batch === null ? null : renderOrNull(step.batch);
      // The token is retained only when its batch is actually delivered with the result;
      // an unrenderable batch is dropped without hiding the call's own outcome.
      return { value: { value: step.value, batch: text }, batchToken: text === null ? null : step.batch!.token };
    });
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
