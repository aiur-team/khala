// The OpenCode session bridge: delivers one Khala inbox batch at a time into the one
// user-started TUI session its binding generation names, by the mode's proven route.
// Every OpenCode and Khala dependency is a port; `plugin.ts` supplies the real ones.
//
//   steer  `tool.execute.after` marks the batch; the next messages transform appends it
//          and re-applies it on later model calls from durable state. Never aborts, and
//          never uses busy `promptAsync`.
//   sync   held while busy; once the session is observed idle, one session-addressed
//          `promptAsync`. `steer` uses the same idle route for a batch arriving at rest.
//   async  nothing automatic; `khala_read` returns the batch.
//
// Acknowledgement is only ever the agent's next Khala call echoing the batch token.

import { createHash } from 'node:crypto';
import {
  type ListeningMode, type SessionBinding,
  OPENCODE_ROUTE_EVIDENCE, decodeDeliveryLimits, openCodePluginCapabilities, resolveOpenCodeModes,
} from '@khala/contracts/delivery/index';
import { cliErrorCode } from '../cli/errors.js';
import type { InboxBatch, WakeableInboxConsumer } from '../cli/inbox.js';
import { MAX_SEND_BYTES, type SendService } from '../cli/send.js';
import type { SendResult } from '../cli/types.js';
import { sameHeldBinding } from '../composition/read.js';
import { nextOpenCodeDeliveryState } from './delivery-contract.js';
import { OPENCODE_BATCH_READ_BYTES, type OpenCodeEnvelope, encodeOpenCodeEnvelope, parseOpenCodeEnvelope } from './envelope.js';
import {
  OPENCODE_MAX_STEER_RECORDS, type OpenCodeBridgeState, type OpenCodeBridgeStore, type OpenCodeDegradedReason,
  type OpenCodeRequest,
} from './store.js';

export const KHALA_READ_TOOL = 'khala_read';
export const KHALA_SEND_TOOL = 'khala_send';

export type OpenCodeModel = Readonly<{ providerID: string; modelID: string }>;
export type OpenCodeSessionStatus = 'idle' | 'busy' | 'retry' | 'missing';

/** One stored OpenCode message, reduced to what reconciliation and drift checks read. */
export type OpenCodeStoredMessage = Readonly<{
  id: string;
  sessionID: string;
  role: string;
  model: OpenCodeModel | null;
  texts: readonly string[];
}>;

/** Session-addressed OpenCode calls through the in-process plugin client only. */
export interface OpenCodeSessionPort {
  status(sessionID: string): Promise<OpenCodeSessionStatus>;
  /** `rejected`: OpenCode refused and stored nothing. Throws when the outcome is unknown. */
  promptAsync(input: Readonly<{ sessionID: string; text: string; model: OpenCodeModel }>): Promise<'accepted' | 'rejected'>;
  messages(sessionID: string): Promise<readonly OpenCodeStoredMessage[]>;
}

/** The held inbox consumer: the shared batch read plus content-free notifier wakes. */
export type OpenCodeBatchPort = Pick<WakeableInboxConsumer, 'readBatch' | 'nextWake'>;

/** Human controls, re-read before every action. A null binding means Stop revoked it. */
export type OpenCodeControls = Readonly<{ binding: SessionBinding | null; paused: boolean; mode: ListeningMode | null }>;
export interface OpenCodeControlPort { read(): Promise<OpenCodeControls>; }

export type OpenCodeSendPort = Pick<SendService, 'send'>;
export type OpenCodeRuntime = Readonly<{ version: string | null; directory: string }>;

/** Content-free delivery evidence: release IDs and boundaries, never bodies or tokens. */
export type OpenCodeBridgeReport = Readonly<{
  type:
    | 'steer.marked' | 'steer.applied' | 'steer.reapplied' | 'steer.released' | 'prompt.submitting'
    | 'prompt.delivered' | 'prompt.reconciled' | 'prompt.outcome_unknown' | 'tool.delivered' | 'degraded'
    | 'uncertain.resolved' | 'error';
  sessionID: string;
  releaseIds?: readonly string[];
  reason?: string;
  at: string;
}>;

/** A mode's route and the recorded session state it needs; see `OPENCODE_ROUTE_EVIDENCE`. */
const ROUTES = {
  steerTool: ['steer', 'busy', 'opencode-plugin-tool-after-transform'],
  steerIdle: ['steer', 'idle', 'opencode-plugin-idle-watcher-prompt'],
  syncAfterBusy: ['sync', 'busy', 'opencode-plugin-session-idle-prompt'],
  syncIdle: ['sync', 'idle', 'opencode-plugin-idle-watcher-prompt'],
} as const;
type RouteName = keyof typeof ROUTES;

export type OpenCodeBridgeOptions = Readonly<{
  binding: SessionBinding;
  batch: OpenCodeBatchPort;
  session: OpenCodeSessionPort;
  controls: OpenCodeControlPort;
  send: OpenCodeSendPort;
  store: OpenCodeBridgeStore;
  runtime: OpenCodeRuntime;
  onReport?: ((report: OpenCodeBridgeReport) => void) | undefined;
  now?: (() => Date) | undefined;
}>;

export type OpenCodeTransformMessage = {
  info: { id: string; sessionID: string; role: string; model?: unknown; [key: string]: unknown };
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
};

export type OpenCodeEvent = Readonly<{ type: string; properties?: unknown }>;

export type OpenCodeBridgeStatus = Readonly<{
  v: 1;
  harness: 'opencode';
  bindingId: string;
  generation: number;
  session: OpenCodeBridgeState['session'];
  runtime: OpenCodeRuntime;
  degraded: OpenCodeDegradedReason | null;
  delivery: Readonly<{ route: OpenCodeRequest['route']; phase: OpenCodeRequest['phase'] }> | null;
  modes: Readonly<Record<ListeningMode, string>>;
  acknowledgement: string;
}>;

type Gate = Readonly<{ controls: OpenCodeControls; state: OpenCodeBridgeState }>;

export class OpenCodeSessionBridge {
  readonly #binding: SessionBinding;
  readonly #batch: OpenCodeBatchPort;
  readonly #session: OpenCodeSessionPort;
  readonly #controls: OpenCodeControlPort;
  readonly #send: OpenCodeSendPort;
  readonly #store: OpenCodeBridgeStore;
  readonly #runtime: OpenCodeRuntime;
  readonly #onReport: ((report: OpenCodeBridgeReport) => void) | undefined;
  readonly #now: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(options: OpenCodeBridgeOptions) {
    this.#binding = options.binding;
    this.#batch = options.batch;
    this.#session = options.session;
    this.#controls = options.controls;
    this.#send = options.send;
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#onReport = options.onReport;
    this.#now = options.now ?? (() => new Date());
  }

  /** The one OpenCode session this binding generation may touch. */
  get sessionID(): string { return this.#binding.sessionId; }
  get binding(): SessionBinding { return this.#binding; }

  /** `tool.execute.after`: mark the pending batch for the next transform of the bound session. */
  async afterTool(input: Readonly<{ sessionID: string; tool: string }>): Promise<void> {
    if (input.sessionID !== this.sessionID || input.tool === KHALA_READ_TOOL || input.tool === KHALA_SEND_TOOL) return;
    await this.#guarded(async () => {
      const gate = await this.#gate();
      if (gate === null || gate.state.request !== null) return;
      if (!this.#automates(gate, 'steer') || !this.#proven('steerTool')) return;
      const batch = await this.#batch.readBatch({ maxBytes: OPENCODE_BATCH_READ_BYTES });
      if (batch === null) return;
      const envelope = await this.#encode(gate.state, batch);
      if (envelope === null) return;
      await this.#store.write({ ...gate.state, request: { token: batch.token, route: 'steer', phase: 'marked', messageID: null } });
      this.#report('steer.marked', envelope.releaseIds);
    });
  }

  /**
   * `experimental.chat.messages.transform`: correlates by the last user message's
   * session, re-applies delivered steer envelopes, then appends a marked batch at the tail.
   */
  async transformMessages(messages: OpenCodeTransformMessage[]): Promise<void> {
    const lastUser = lastWhere(messages, message => message.info.role === 'user');
    // A transform for another session skips without dropping the marked batch.
    if (lastUser === undefined || lastUser.info.sessionID !== this.sessionID) return;
    await this.#guarded(async () => {
      let gate = await this.#gate(modelOf(lastUser.info.model));
      if (gate === null) return;
      for (const record of gate.state.steer) {
        if (messages.some(message => message.parts.some(part => part.type === 'text' && part.text === record.envelope))) continue;
        if (placeEnvelope(messages, record.anchorMessageID, record.envelope, record.token, lastUser)) {
          this.#report('steer.reapplied', parseOpenCodeEnvelope(record.envelope)?.releaseIds ?? []);
        }
      }
      const request = gate.state.request;
      if (request === null || request.route !== 'steer' || request.phase !== 'marked') return;
      if (!this.#automates(gate, 'steer') || !this.#proven('steerTool')) {
        // A human control changed after marking; nothing was placed, so the batch stays pending.
        await this.#store.write({ ...gate.state, request: null });
        this.#report('steer.released', []);
        return;
      }
      const batch = await this.#batch.readBatch({ maxBytes: OPENCODE_BATCH_READ_BYTES });
      gate = { ...gate, state: await this.#settleAcknowledged(gate.state, batch) };
      if (batch === null || gate.state.request === null) return;
      const envelope = await this.#encode(gate.state, batch);
      if (envelope === null) return;
      const anchorMessageID = messages.at(-1)!.info.id;
      // Durable before visible: a restart re-applies from this record, never from memory.
      await this.#store.write({
        ...gate.state,
        request: { ...request, phase: 'delivered' },
        steer: [...gate.state.steer, { token: batch.token, anchorMessageID, envelope: envelope.text }]
          .slice(-OPENCODE_MAX_STEER_RECORDS),
      });
      placeEnvelope(messages, anchorMessageID, envelope.text, batch.token, lastUser);
      this.#report('steer.applied', envelope.releaseIds);
    });
  }

  /** Session events are hints: only the bound session's idle or deletion matters. */
  async onEvent(event: OpenCodeEvent): Promise<void> {
    const properties = plain(event.properties);
    if (event.type === 'session.deleted') {
      if (plain(properties?.info)?.id !== this.sessionID) return;
      await this.#guarded(async () => {
        const state = await this.#store.read();
        if (state.degraded === null) await this.#degrade(state, 'session_missing');
      });
      return;
    }
    if (properties?.sessionID !== this.sessionID) return;
    const idle = event.type === 'session.idle'
      || (event.type === 'session.status' && plain(properties.status)?.type === 'idle');
    if (idle) await this.wake('session_idle');
  }

  /** Waits for notifier hints (the first is the start-up catch-up) until `signal` aborts. */
  async runIdleWatcher(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await abortable(this.#batch.nextWake(), signal);
      } catch {
        return;
      }
      if (signal.aborted) return;
      await this.wake('hint');
    }
  }

  /**
   * The idle route for `sync` and `steer`: re-reads controls and the bound session's
   * status, then submits one session-addressed `promptAsync` only when it is idle.
   */
  async wake(trigger: 'hint' | 'session_idle'): Promise<void> {
    await this.#guarded(async () => {
      let gate = await this.#gate();
      if (gate === null) return;
      if (gate.state.request?.phase === 'submitting') {
        // A restart interrupted a submit: reconcile, never resubmit.
        gate = { ...gate, state: await this.#reconcile(gate.state, gate.state.request) };
      }
      const mode = gate.controls.mode;
      if (mode !== 'steer' && mode !== 'sync' || !this.#automates(gate, mode)) return;
      const route: RouteName = mode === 'steer' ? 'steerIdle' : trigger === 'session_idle' ? 'syncAfterBusy' : 'syncIdle';
      if (!this.#proven(route)) return;

      const batch = await this.#batch.readBatch({ maxBytes: OPENCODE_BATCH_READ_BYTES });
      let state = await this.#settleAcknowledged(gate.state, batch);
      if (batch === null) return;
      // Duplicate and catch-up hints for a batch already taken never submit it again. A
      // steer mark whose model call never came (the session is idle) moves to this route.
      if (state.request !== null && !(state.request.route === 'steer' && state.request.phase === 'marked')) return;

      const status = await this.#session.status(this.sessionID);
      if (status === 'missing') {
        await this.#degrade(state, 'session_missing');
        return;
      }
      if (status !== 'idle') return;
      state = await this.#observe(state, latestUserModel(await this.#session.messages(this.sessionID), this.sessionID));
      if (state.degraded !== null || state.session === null) return;
      const envelope = await this.#encode(state, batch);
      if (envelope === null) return;

      // Status observation and submit are not atomic: re-read both immediately before.
      const again = await this.#gate();
      if (again === null || again.controls.mode !== mode || !this.#automates(again, mode)) return;
      if (await this.#session.status(this.sessionID) !== 'idle') return;

      const submitting: OpenCodeRequest = { token: batch.token, route: 'idle_prompt', phase: 'submitting', messageID: null };
      state = { ...state, request: submitting };
      await this.#store.write(state);
      this.#report('prompt.submitting', envelope.releaseIds);
      let outcome: 'accepted' | 'rejected';
      try {
        outcome = await this.#session.promptAsync({
          sessionID: this.sessionID,
          text: envelope.text,
          model: { providerID: state.session!.providerID, modelID: state.session!.modelID },
        });
      } catch {
        await this.#reconcile(state, submitting);
        return;
      }
      if (outcome === 'rejected') {
        await this.#degrade({ ...state, request: null }, 'prompt_rejected');
        return;
      }
      await this.#store.write({ ...state, request: { ...submitting, phase: 'delivered' } });
      this.#report('prompt.delivered', envelope.releaseIds);
    });
  }

  /** `khala_read`: the explicit pull. `ackBatchToken` is the only acknowledgement path. */
  async read(input: Readonly<{ sessionID: string; ackBatchToken?: string | undefined }>): Promise<string> {
    if (input.sessionID !== this.sessionID) return refused('binding_not_held');
    return this.#serialized(async () => {
      const gate = await this.#toolGate();
      if (typeof gate === 'string') return refused(gate);
      const batch = await this.#readForTool(input.ackBatchToken);
      const state = await this.#settleAcknowledged(gate.state, batch);
      if (batch === null) return JSON.stringify({ kind: 'empty' });
      const envelope = await this.#deliverToTool(state, batch);
      return envelope === null ? refused('envelope_too_large') : `${JSON.stringify({ kind: 'batch' })}\n\n${envelope.text}`;
    });
  }

  /** `khala_send`: a deliberate reply. A following batch is appended, as MCP piggyback does. */
  async sendMessage(
    input: Readonly<{ sessionID: string; message: string; ackBatchToken?: string | undefined }>,
  ): Promise<string> {
    if (input.sessionID !== this.sessionID) return refused('binding_not_held');
    return this.#serialized(async () => {
      const gate = await this.#toolGate();
      if (typeof gate === 'string') return refused(gate);
      let result: SendResult;
      try {
        result = await this.#send.send(input.message, this.#binding.bindingId);
      } catch (error) {
        return refused(cliErrorCode(error));
      }
      const primary = JSON.stringify(publicSendResult(result));
      const batch = await this.#readForTool(input.ackBatchToken);
      const state = await this.#settleAcknowledged(gate.state, batch);
      if (batch === null) return primary;
      const envelope = await this.#deliverToTool(state, batch);
      return envelope === null ? primary : `${primary}\n\n${envelope.text}`;
    });
  }

  /** The human decision that unblocks `outcome_unknown`. Nothing replays without it. */
  async resolveUncertain(decision: 'confirmed_stored' | 'authorize_replay'): Promise<boolean> {
    return this.#serialized(async () => {
      const state = await this.#store.read();
      const request = state.request;
      if (request === null || request.phase !== 'uncertain') return false;
      const event = decision === 'confirmed_stored' ? 'human_confirmed_stored' : 'human_authorized_replay';
      const next = nextOpenCodeDeliveryState('uncertain', event);
      if (!next.ok) return false;
      await this.#store.write({ ...state, request: next.state === 'delivered' ? { ...request, phase: 'delivered' } : null });
      this.#report('uncertain.resolved', [], decision);
      return true;
    });
  }

  /** Preflight and binding evidence for setup status and acceptance; content-free. */
  async status(): Promise<OpenCodeBridgeStatus> {
    const state = await this.#store.read();
    const capabilities = this.#capabilities();
    const modes = resolveOpenCodeModes(capabilities);
    return {
      v: 1,
      harness: 'opencode',
      bindingId: this.#binding.bindingId,
      generation: this.#binding.generation,
      session: state.session,
      runtime: this.#runtime,
      degraded: state.degraded,
      delivery: state.request === null ? null : { route: state.request.route, phase: state.request.phase },
      modes: { steer: modes.steer.status, sync: modes.sync.status, async: modes.async.status },
      acknowledgement: capabilities.acknowledgement,
    };
  }

  // Current controls and state, or null when Stop revoked the binding, the generation is
  // stale, the binding degraded, or the tuple drifted. `model` is the bound session's
  // latest observed model, recorded on first sight and compared afterwards.
  async #gate(model: OpenCodeModel | null = null): Promise<Gate | null> {
    const controls = await this.#controls.read();
    if (!sameHeldBinding(this.#binding, controls.binding)) return null;
    let state = await this.#store.read();
    if (state.degraded !== null) return null;
    state = await this.#observe(state, model);
    return state.degraded === null ? { controls, state } : null;
  }

  async #toolGate(): Promise<Gate | 'binding_not_held' | 'binding_degraded' | 'outcome_unknown'> {
    const controls = await this.#controls.read();
    if (!sameHeldBinding(this.#binding, controls.binding)) return 'binding_not_held';
    const state = await this.#store.read();
    if (state.degraded !== null) return 'binding_degraded';
    if (state.request?.phase === 'uncertain' || state.request?.phase === 'submitting') return 'outcome_unknown';
    return { controls, state };
  }

  // Human `pause` and the requested mode both outrank delivery; `uncertain` blocks.
  #automates(gate: Gate, mode: ListeningMode): boolean {
    return !gate.controls.paused && gate.controls.mode === mode && gate.state.request?.phase !== 'uncertain';
  }

  #capabilities() {
    const limits = decodeDeliveryLimits({ maxSelectionEvents: 32, maxPayloadBytes: MAX_SEND_BYTES });
    if (!limits.ok) throw new TypeError('invalid OpenCode delivery limits');
    return openCodePluginCapabilities({
      version: this.#runtime.version ?? 'unknown', limits: limits.value, claims: OPENCODE_ROUTE_EVIDENCE,
    });
  }

  // A route is used only when its exact evidence key is recorded for the running
  // version and `HarnessCapabilities` resolves the mode as proven.
  #proven(name: RouteName): boolean {
    const version = this.#runtime.version;
    if (version === null) return false;
    const [mode, sessionState, route] = ROUTES[name];
    const capabilities = this.#capabilities();
    if (capabilities.acknowledgement !== 'batch_token_next_call') return false;
    if (resolveOpenCodeModes(capabilities)[mode].status !== 'proven') return false;
    return OPENCODE_ROUTE_EVIDENCE.some(key => key.harnessVersion === version && key.pluginApiVersion === version
      && key.mode === mode && key.sessionState === sessionState && key.route === route && key.surface === 'in_process_plugin');
  }

  async #observe(state: OpenCodeBridgeState, model: OpenCodeModel | null): Promise<OpenCodeBridgeState> {
    const { version, directory } = this.#runtime;
    if (state.session === null) {
      if (model === null || version === null) return state;
      const next = { ...state, session: { sessionID: this.sessionID, directory, opencodeVersion: version, ...model } };
      await this.#store.write(next);
      return next;
    }
    const drift: OpenCodeDegradedReason | null = state.session.opencodeVersion !== version ? 'version_drift'
      : state.session.directory !== directory ? 'directory_drift'
        : model !== null && (model.providerID !== state.session.providerID || model.modelID !== state.session.modelID)
          ? 'model_drift' : null;
    return drift === null ? state : this.#degrade(state, drift);
  }

  async #encode(state: OpenCodeBridgeState, batch: InboxBatch): Promise<OpenCodeEnvelope | null> {
    const encoded = encodeOpenCodeEnvelope(batch);
    if (encoded.ok) return encoded.envelope;
    await this.#degrade(state, 'envelope_too_large');
    return null;
  }

  async #degrade(state: OpenCodeBridgeState, reason: OpenCodeDegradedReason): Promise<OpenCodeBridgeState> {
    const next = { ...state, degraded: reason };
    await this.#store.write(next);
    this.#report('degraded', [], reason);
    return next;
  }

  // The agent's next Khala call acknowledged the in-flight token when the inbox no
  // longer offers it. Only then is the request forgotten.
  async #settleAcknowledged(state: OpenCodeBridgeState, batch: InboxBatch | null): Promise<OpenCodeBridgeState> {
    if (state.request === null || (batch !== null && batch.token === state.request.token)) return state;
    if (state.request.phase === 'uncertain' || state.request.phase === 'submitting') return state;
    const next = { ...state, request: null };
    await this.#store.write(next);
    return next;
  }

  async #reconcile(state: OpenCodeBridgeState, request: OpenCodeRequest): Promise<OpenCodeBridgeState> {
    let messageID: string | null = null;
    try {
      for (const message of await this.#session.messages(this.sessionID)) {
        if (message.role !== 'user' || message.sessionID !== this.sessionID) continue;
        if (message.texts.some(text => parseOpenCodeEnvelope(text)?.token === request.token)) messageID = message.id;
      }
    } catch {
      messageID = null;
    }
    const event = messageID === null ? 'outcome_unknown' : 'submitted';
    const next = nextOpenCodeDeliveryState('leased', event);
    if (!next.ok) throw new TypeError('invalid OpenCode delivery transition');
    const reconciled: OpenCodeRequest = { ...request, phase: next.state === 'delivered' ? 'delivered' : 'uncertain', messageID };
    const updated = { ...state, request: reconciled };
    await this.#store.write(updated);
    this.#report(messageID === null ? 'prompt.outcome_unknown' : 'prompt.reconciled', []);
    return updated;
  }

  async #readForTool(ackBatchToken: string | undefined): Promise<InboxBatch | null> {
    return this.#batch.readBatch({
      maxBytes: OPENCODE_BATCH_READ_BYTES,
      explicitRead: true,
      ...(ackBatchToken === undefined ? {} : { acknowledgeToken: ackBatchToken }),
    });
  }

  // A batch returned in a tool result is delivered; recording it keeps the idle route
  // from submitting the same token again before the agent acknowledges it.
  async #deliverToTool(state: OpenCodeBridgeState, batch: InboxBatch): Promise<OpenCodeEnvelope | null> {
    const envelope = await this.#encode(state, batch);
    if (envelope === null) return null;
    if (state.request?.token !== batch.token || state.request.phase === 'marked') {
      await this.#store.write({ ...state, request: { token: batch.token, route: 'tool_result', phase: 'delivered', messageID: null } });
    }
    this.#report('tool.delivered', envelope.releaseIds);
    return envelope;
  }

  // Hooks run inside the person's TUI: a failure is reported and fails closed, never thrown.
  async #guarded(work: () => Promise<void>): Promise<void> {
    try {
      await this.#serialized(work);
    } catch (error) {
      this.#report('error', [], cliErrorCode(error));
    }
  }

  async #serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(work, work);
    this.#serial = result.then(() => undefined, () => undefined);
    return result;
  }

  #report(type: OpenCodeBridgeReport['type'], releaseIds: readonly string[], reason?: string): void {
    try {
      this.#onReport?.({
        type, sessionID: this.sessionID, at: this.#now().toISOString(),
        ...(releaseIds.length > 0 ? { releaseIds } : {}), ...(reason === undefined ? {} : { reason }),
      });
    } catch {
      // Evidence reporting never changes delivery.
    }
  }
}

function placeEnvelope(
  messages: OpenCodeTransformMessage[],
  anchorMessageID: string,
  text: string,
  token: string,
  user: OpenCodeTransformMessage,
): boolean {
  const index = messages.findIndex(message => message.info.id === anchorMessageID);
  if (index < 0) return false;
  const id = `${anchorMessageID}_khala_${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
  messages.splice(index + 1, 0, {
    info: { ...user.info, id },
    parts: [{ id: `${id}_part`, messageID: id, sessionID: user.info.sessionID, type: 'text', text }],
  });
  return true;
}

function latestUserModel(messages: readonly OpenCodeStoredMessage[], sessionID: string): OpenCodeModel | null {
  return lastWhere(messages, message => message.role === 'user' && message.sessionID === sessionID)?.model ?? null;
}

function lastWhere<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) if (predicate(items[index]!)) return items[index];
  return undefined;
}

function modelOf(value: unknown): OpenCodeModel | null {
  const model = plain(value);
  return typeof model?.providerID === 'string' && typeof model.modelID === 'string'
    ? { providerID: model.providerID, modelID: model.modelID } : null;
}

function plain(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function refused(code: string): string {
  return JSON.stringify({ kind: 'refused', code });
}

function publicSendResult(result: SendResult): Record<string, string | null> {
  if (result.kind === 'accepted') return { kind: result.kind, clientTxnId: result.clientTxnId, eventId: result.eventId };
  if (result.kind === 'refused') return { kind: result.kind, code: result.code, clientTxnId: result.clientTxnId };
  return { kind: result.kind, clientTxnId: result.clientTxnId };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}
