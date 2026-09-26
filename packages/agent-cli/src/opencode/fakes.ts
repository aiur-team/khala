// Test doubles for the OpenCode session bridge: one fake TUI process holding several
// sessions, a scripted wake source, mutable human controls and a recording sender.

import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { SendResult } from '../cli/types.js';
import type {
  OpenCodeControls, OpenCodeModel, OpenCodeSessionPort, OpenCodeSessionStatus, OpenCodeStoredMessage,
  OpenCodeTransformMessage,
} from './bridge.js';
import { parseOpenCodeEnvelope } from './envelope.js';

export const DEEPSEEK: OpenCodeModel = { providerID: 'deepseek', modelID: 'deepseek-flash' };

type PromptBehavior = 'accept' | 'reject' | 'throw_after_store' | 'throw_before_store';

/**
 * A fake OpenCode process. `calls` logs every port call with the session it named, so a
 * test can prove that nothing ever addressed another session. There is no abort, draft
 * or TUI-endpoint API at all: the bridge cannot reach one.
 */
export class FakeOpenCode implements OpenCodeSessionPort {
  readonly statuses = new Map<string, OpenCodeSessionStatus>();
  readonly stored = new Map<string, OpenCodeStoredMessage[]>();
  readonly drafts = new Map<string, string>();
  readonly prompts: { sessionID: string; text: string; model: OpenCodeModel }[] = [];
  readonly calls: string[] = [];
  readonly timeline: string[] = [];
  promptBehavior: PromptBehavior = 'accept';
  messagesFail = false;
  model: OpenCodeModel = DEEPSEEK;
  #counter = 0;

  constructor(sessions: readonly string[]) {
    for (const session of sessions) {
      this.statuses.set(session, 'idle');
      this.stored.set(session, []);
    }
  }

  userTurn(sessionID: string, text: string): void {
    this.#append(sessionID, 'user', text, this.model);
    this.statuses.set(sessionID, 'busy');
  }

  toolResult(sessionID: string, text: string): void {
    this.#append(sessionID, 'assistant', text, null);
  }

  async status(sessionID: string): Promise<OpenCodeSessionStatus> {
    this.calls.push(`status:${sessionID}`);
    return this.statuses.get(sessionID) ?? 'missing';
  }

  async promptAsync(input: Readonly<{ sessionID: string; text: string; model: OpenCodeModel }>): Promise<'accepted' | 'rejected'> {
    this.calls.push(`promptAsync:${input.sessionID}`);
    this.timeline.push(`prompt:${input.sessionID}`);
    this.prompts.push({ ...input });
    switch (this.promptBehavior) {
      case 'reject': return 'rejected';
      case 'throw_before_store': throw new Error('socket hang up');
      case 'throw_after_store':
        this.#append(input.sessionID, 'user', input.text, input.model);
        throw new Error('socket hang up');
      default:
        this.#append(input.sessionID, 'user', input.text, input.model);
        return 'accepted';
    }
  }

  async messages(sessionID: string): Promise<readonly OpenCodeStoredMessage[]> {
    this.calls.push(`messages:${sessionID}`);
    if (this.messagesFail) throw new Error('messages unavailable');
    return [...(this.stored.get(sessionID) ?? [])];
  }

  /** The model context OpenCode rebuilds from storage for one model call. */
  context(sessionID: string): OpenCodeTransformMessage[] {
    return (this.stored.get(sessionID) ?? []).map(message => ({
      info: {
        id: message.id, sessionID: message.sessionID, role: message.role,
        ...(message.model === null ? {} : { model: { ...message.model } }),
      },
      parts: message.texts.map(text => ({ type: 'text', text })),
    }));
  }

  #append(sessionID: string, role: string, text: string, model: OpenCodeModel | null): void {
    this.#counter += 1;
    const messages = this.stored.get(sessionID);
    if (messages === undefined) throw new Error(`unknown session ${sessionID}`);
    messages.push({
      id: `msg_${String(this.#counter).padStart(4, '0')}`, sessionID, role,
      model: model === null ? null : { ...model }, texts: [text],
    });
  }
}

/** Batch tokens visible to the model in one transformed context. */
export function envelopeTokens(messages: readonly OpenCodeTransformMessage[]): string[] {
  return messages.flatMap(message => message.parts.flatMap(part => {
    const parsed = typeof part.text === 'string' ? parseOpenCodeEnvelope(part.text) : null;
    return parsed === null ? [] : [parsed.token];
  }));
}

/** Content-free wakes on demand; `release()` ends the watcher like listener release does. */
export class FakeWakes {
  #pending = 0;
  #waiter: { resolve(): void; reject(error: Error): void } | null = null;
  #released = false;

  hint(): void {
    if (this.#waiter !== null) {
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter.resolve();
    } else this.#pending += 1;
  }

  nextWake(): Promise<void> {
    if (this.#released) return Promise.reject(new Error('listener_busy'));
    if (this.#pending > 0) {
      this.#pending = 0;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => { this.#waiter = { resolve, reject }; });
  }

  release(): void {
    this.#released = true;
    this.#waiter?.reject(new Error('listener_busy'));
    this.#waiter = null;
  }
}

export class FakeControls {
  value: OpenCodeControls;
  reads = 0;
  /** Runs once, on the given read, to model a human control racing the bridge. */
  onRead: ((read: number) => void) | null = null;

  constructor(binding: SessionBinding, mode: OpenCodeControls['mode']) {
    this.value = { binding, paused: false, mode };
  }

  async read(): Promise<OpenCodeControls> {
    this.reads += 1;
    this.onRead?.(this.reads);
    return this.value;
  }

  set(patch: Partial<OpenCodeControls>): void {
    this.value = { ...this.value, ...patch };
  }
}

export class FakeSend {
  readonly sent: string[] = [];
  result: SendResult['kind'] = 'accepted';

  async send(body: string): Promise<SendResult> {
    this.sent.push(body);
    const clientTxnId = `txn-${this.sent.length}-0000`;
    if (this.result === 'accepted') return { kind: 'accepted', clientTxnId, eventId: `event-${this.sent.length}` };
    if (this.result === 'refused') return { kind: 'refused', code: 'binding_not_held', clientTxnId };
    return { kind: 'outcome_unknown', clientTxnId };
  }
}
