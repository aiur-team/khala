import {
  type HarnessCapabilities, type ListeningModeControl, type ListeningModeResult, type SessionBinding,
  decodeListeningModeResult,
} from '@khala/contracts/delivery/index';
import type { GrantedDescriptor } from '@khala/contracts/internal/descriptor';
import { listeningModeView, refusedListeningModeResult } from '@khala/policy/listening-mode/store';
import type { AgentListeningModeApplication } from '@khala/connector/agent/listening-mode';
import { publicBinding } from '../cli/runtime.js';
import type { AgentListeningModeStatus } from '../cli/types.js';
import { plainObject, validIdentifier } from '../cli/validation.js';
import { LISTENING_MODES } from './listening-mode.js';

// The held binding's listening mode, for a descriptor-backed local client. The
// internal server owns the durable control record and the owner's pause; this
// side projects that record through the released capability claim of the
// harness actually running here, which only this side can inspect (the Codex
// version and the user's hook trust). The server's own projection is replaced,
// never trusted, so a mode the local harness has not proven stays unusable.

export const AGENT_LISTENING_MODE_PATH = '/api/v1/agent/listening-mode';

/** The released claim for the harness this binding runs in; null when it cannot be inspected. */
export type LocalHarnessCapabilities = (binding: SessionBinding) => Promise<HarnessCapabilities | null>;

/** What the harness running this binding shows about itself (version and hook trust); null when nothing applies. */
export type LocalHarnessObservation = (binding: SessionBinding) => Promise<Readonly<{
  version: string; hookReview: 'trusted' | 'awaiting_hook_review' | 'unknown';
}> | null>;

export const AGENT_HARNESS_PATH = '/api/v1/agent/harness';

type Call = (
  descriptor: GrantedDescriptor, target: string, init: Readonly<{ method: 'GET' | 'POST'; body?: unknown }>, signal?: AbortSignal,
) => Promise<Readonly<{ status: number; body: unknown }>>;

export type InternalListeningModeOptions = Readonly<{
  /** Reopens the descriptor for every call; null when it is missing, unsafe or not granted. */
  descriptor: () => GrantedDescriptor | null;
  call: Call;
  capabilities: LocalHarnessCapabilities;
  /** Reported once per process so the owner sees the same claim this side projects through. */
  observation?: LocalHarnessObservation;
}>;

export type InternalListeningMode = AgentListeningModeApplication & Readonly<{
  /** The effective mode native hooks act on; `effective` is null whenever anything is unknown. */
  status(signal?: AbortSignal): Promise<AgentListeningModeStatus | null>;
}>;

function control(value: unknown): ListeningModeControl | null {
  if (!plainObject(value) || !validIdentifier(value.bindingId) || !Number.isSafeInteger(value.generation)
    // `null` when the server had no evidence of any mode to request.
    || !(value.requested === null
      || (typeof value.requested === 'string' && (LISTENING_MODES as readonly string[]).includes(value.requested)))
    || !Number.isSafeInteger(value.version) || (value.version as number) < 1
    || !Array.isArray(value.experimentalGrants) || !value.experimentalGrants.every(plainObject)
    || !Array.isArray(value.hardCancelGrants) || !value.hardCancelGrants.every(plainObject)
    || !plainObject(value.lastChangedBy)) return null;
  return {
    bindingId: value.bindingId,
    generation: value.generation,
    requested: value.requested,
    version: value.version,
    experimentalGrants: value.experimentalGrants,
    hardCancelGrants: value.hardCancelGrants,
    lastChangedBy: value.lastChangedBy,
  } as unknown as ListeningModeControl;
}

function refusalCode(status: number): 'binding_revoked' | 'unavailable' {
  return status === 401 || status === 403 ? 'binding_revoked' : 'unavailable';
}

export function createInternalListeningMode(options: InternalListeningModeOptions): InternalListeningMode {
  const reported = new Set<string>();

  /** Best effort: a failed report changes nothing this side projects, and the next process reports again. */
  async function report(descriptor: GrantedDescriptor, binding: SessionBinding, signal?: AbortSignal): Promise<void> {
    const key = JSON.stringify([binding.bindingId, binding.generation]);
    if (!options.observation || reported.has(key)) return;
    reported.add(key);
    try {
      const observation = await options.observation(binding);
      if (observation !== null) {
        await options.call(descriptor, AGENT_HARNESS_PATH, { method: 'POST', body: { v: 1, ...observation } }, signal);
      }
    } catch { /* The owner's view stays at what the server last knew. */ }
  }

  async function current(signal?: AbortSignal) {
    const descriptor = options.descriptor();
    if (descriptor === null) return { ok: false, code: 'unavailable' } as const;
    let reply;
    try {
      reply = await options.call(descriptor, AGENT_LISTENING_MODE_PATH, { method: 'GET' }, signal);
    } catch {
      return { ok: false, code: 'unavailable' } as const;
    }
    if (reply.status !== 200) return { ok: false, code: refusalCode(reply.status) } as const;
    if (!plainObject(reply.body) || reply.body.v !== 1) return { ok: false, code: 'unavailable' } as const;
    let binding: SessionBinding;
    try { binding = publicBinding(reply.body.binding); } catch { return { ok: false, code: 'unavailable' } as const; }
    const record = plainObject(reply.body.view) ? control(reply.body.view) : null;
    // The answer must be for the binding this descriptor names, and for that binding's own record.
    if (record === null || binding.bindingId !== descriptor.bindingId || record.bindingId !== binding.bindingId
      || record.generation !== binding.generation) return { ok: false, code: 'unavailable' } as const;
    let capabilities: HarnessCapabilities | null;
    try { capabilities = await options.capabilities(binding); } catch { capabilities = null; }
    // Only a claim for this binding's own harness applies.
    if (capabilities !== null && capabilities.harness !== binding.harness) capabilities = null;
    await report(descriptor, binding, signal);
    return { ok: true, binding, capabilities, view: listeningModeView(record, capabilities) } as const;
  }

  return {
    async read() {
      const read = await current();
      return read.ok ? { ok: true, view: read.view } : read;
    },

    async set(input): Promise<ListeningModeResult> {
      const descriptor = options.descriptor();
      const refused = (reason: string) => refusedListeningModeResult({
        v: 1, commandId: input.commandId, bindingId: (descriptor?.bindingId ?? 'unbound') as ListeningModeResult['bindingId'],
        expectedBindingGeneration: 0, expectedVersion: input.expectedVersion, requested: input.requested, issuedAt: input.issuedAt,
      }, reason);
      if (descriptor === null) return refused('unavailable');
      // A failure after the request left may hide a committed write; the caller reports it as unknown.
      const reply = await options.call(descriptor, AGENT_LISTENING_MODE_PATH, {
        method: 'POST',
        body: { v: 1, commandId: input.commandId, expectedVersion: input.expectedVersion, requested: input.requested, issuedAt: input.issuedAt },
      });
      if (reply.status === 401 || reply.status === 403) return refused('binding_revoked');
      const decoded = reply.status === 200 ? decodeListeningModeResult(reply.body) : null;
      if (decoded === null || !decoded.ok) throw new Error('listening mode: unreadable result');
      const result = decoded.value;
      if (result.bindingId !== descriptor.bindingId) throw new Error('listening mode: foreign binding');
      if (result.outcome === 'refused') return result;
      // Re-project the written record through this harness; keep the server's result if the record moved on.
      const read = await current();
      if (!read.ok || read.view.version !== result.version) return { ...result, effective: null, reason: 'capabilities_unavailable' };
      return { ...result, effective: read.view.effective, reason: read.view.effectiveReason };
    },

    async status(signal) {
      const read = await current(signal);
      if (!read.ok) return null;
      return { v: 1, bindingId: read.binding.bindingId, generation: read.binding.generation, effective: read.view.effective };
    },
  };
}
