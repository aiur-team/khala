import type { SessionBinding } from '@khala/contracts/delivery/index';
import { isGrantedDescriptor } from '@khala/contracts/internal/descriptor';
import { type DescriptorRead, readInternalDescriptor } from './internal.js';
import { internalSessionDigest } from './internal-session.js';

export const CODEX_IDLE_WAKE_PATH = '/api/v1/agent/idle-wake';
export const CODEX_TURN_END_PATH = '/api/v1/agent/automation-turn-end';

/** Called only after the installed Codex Stop hook marked this exact session idle. */
export function createInstalledCodexTurnEnd(input: Readonly<{
  sessionId: string;
  binding: SessionBinding;
  descriptorPath: string;
  fetch?: typeof globalThis.fetch;
  readDescriptor?: (file: string) => DescriptorRead;
}>): () => Promise<void> {
  const { binding, sessionId } = input;
  if (binding.harness !== 'codex' || binding.sessionId !== internalSessionDigest('codex', sessionId)) return async () => {};
  const fetcher = input.fetch ?? globalThis.fetch;
  const read = input.readDescriptor ?? readInternalDescriptor;
  return async () => {
    const descriptor = read(input.descriptorPath);
    if (!descriptor.ok || !isGrantedDescriptor(descriptor.value) || descriptor.value.bindingId !== binding.bindingId) return;
    await fetcher(new URL(CODEX_TURN_END_PATH, descriptor.value.origin), {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${descriptor.value.bindingCapability}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, sessionId, channelId: descriptor.value.channelId }),
      signal: AbortSignal.timeout(15_000),
    });
  };
}

/** The installed MCP entry reports only the native thread after a durable arrival. */
export function createInstalledCodexWake(input: Readonly<{
  sessionId: string;
  binding: SessionBinding;
  descriptorPath: string;
  fetch?: typeof globalThis.fetch;
  readDescriptor?: (file: string) => DescriptorRead;
}>): () => Promise<void> {
  const { binding, sessionId } = input;
  if (binding.harness !== 'codex' || binding.sessionId !== internalSessionDigest('codex', sessionId)) return async () => {};
  const fetcher = input.fetch ?? globalThis.fetch;
  const read = input.readDescriptor ?? readInternalDescriptor;
  return async () => {
    const descriptor = read(input.descriptorPath);
    if (!descriptor.ok || !isGrantedDescriptor(descriptor.value) || descriptor.value.bindingId !== binding.bindingId) return;
    await fetcher(new URL(CODEX_IDLE_WAKE_PATH, descriptor.value.origin), {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${descriptor.value.bindingCapability}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, sessionId }),
      signal: AbortSignal.timeout(15_000),
    });
  };
}
