import type { Readable, Writable } from 'node:stream';
import type { AppHarnessRecord, ListeningMode, SessionBinding } from '@khala/contracts/delivery/index';
import { callScopedConsumer } from '../cli/call-consumer.js';
import { CliError, cliErrorCode } from '../cli/errors.js';
import type { BatchInbox } from '../cli/inbox.js';
import {
  type CodexHookInput, CODEX_HOOK_MAX_OUTPUT_BYTES, CODEX_HOOK_MAX_PAYLOAD_BYTES, codexOfferScope,
  decodeCodexHookInput, decodeListeningModeStatus, readJson, renderCodexHookOutput, write,
} from '../codex/hook.js';
import { ReadOperation } from '../composition/read.js';
import { renderInboxBatch } from '../mcp/result-postprocessor.js';

/**
 * The two app boundaries a Khala handler may use. There is no `PreToolUse`: blocking a
 * tool before it runs is an abort, and hard abort is a separate opt-in capability.
 */
export const CODEX_APP_HOOK_EVENTS = ['PostToolUse', 'Stop'] as const;
export type CodexAppHookEvent = (typeof CODEX_APP_HOOK_EVENTS)[number];

export type CodexAppHookInput = CodexHookInput & Readonly<{ event: CodexAppHookEvent }>;

export type CodexAppHookDependencies = Readonly<{
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  currentBinding: () => Promise<SessionBinding | null>;
  listeningMode: () => Promise<unknown>;
  inbox: (bindingId: string, generation: number) => Promise<BatchInbox>;
  /** Records, content-free, that this handler ran at a boundary of this session. */
  recordHookRun: (sessionId: string, event: CodexAppHookEvent) => Promise<void>;
  /** The current app capability record, inspected after the run is recorded; `null` fails closed. */
  inspect: () => Promise<AppHarnessRecord | null>;
  signal?: AbortSignal | undefined;
}>;

export function decodeCodexAppHookInput(value: unknown): CodexAppHookInput | null {
  const input = decodeCodexHookInput(value);
  if (input === null || !(CODEX_APP_HOOK_EVENTS as readonly string[]).includes(input.event)) return null;
  return input as CodexAppHookInput;
}

/**
 * Whether this boundary delivers, given the effective mode and the inspected record.
 * `PostToolUse` delivers only for a proven `steer` cell. `Stop` delivers only for a
 * proven `sync` cell, and never while Codex is already continuing from a Stop block,
 * which bounds the continuation to one per turn.
 */
export function codexAppHookDelivery(
  mode: ListeningMode,
  input: CodexAppHookInput,
  record: AppHarnessRecord | null,
): 'block' | 'context' | null {
  if (record === null || mode === 'async') return null;
  const modes = record.capabilities.modes;
  if (input.event === 'PostToolUse') {
    return mode === 'steer' && record.boundaries.steer === 'PostToolUse' && modes.steer.status === 'proven'
      ? 'context' : null;
  }
  if (input.stopHookActive) return null;
  return record.boundaries.sync === 'Stop' && modes.sync.status === 'proven' ? 'block' : null;
}

/**
 * Handles one Codex app hook invocation. It never acknowledges a batch, starts or signals
 * Codex, or fails the user's turn. With no batch it returns without output, so a Stop
 * hands control back to the person.
 */
export async function runCodexAppHook(deps: CodexAppHookDependencies): Promise<void> {
  try {
    const input = decodeCodexAppHookInput(await readJson(deps.stdin));
    if (input === null) return;
    const binding = await deps.currentBinding();
    if (binding === null || binding.harness !== 'codex' || binding.sessionId !== input.sessionId) return;
    await deps.recordHookRun(input.sessionId, input.event);
    const mode = decodeListeningModeStatus(await deps.listeningMode());
    if (mode === null || mode.bindingId !== binding.bindingId || mode.generation !== binding.generation
      || mode.effective === null) return;
    const delivery = codexAppHookDelivery(mode.effective, input, await deps.inspect());
    if (delivery === null) return;

    const inbox = await deps.inbox(binding.bindingId, binding.generation);
    const read = new ReadOperation({
      heldBinding: binding,
      consumer: callScopedConsumer(inbox, { signal: deps.signal }),
      currentBinding: deps.currentBinding,
    });
    const result = await read.read({
      bindingId: binding.bindingId,
      maxBytes: CODEX_HOOK_MAX_PAYLOAD_BYTES,
      offerScope: codexOfferScope(input),
      turnStart: false,
    });
    if (result.kind === 'empty') return;
    const output = renderCodexHookOutput(input.event, delivery, renderInboxBatch(result.batch));
    if (Buffer.byteLength(output) > CODEX_HOOK_MAX_OUTPUT_BYTES) throw new CliError('invalid_input');
    await write(deps.stdout, output);
  } catch (error) {
    await write(deps.stderr, JSON.stringify({ ok: false, warning: 'codex_app_hook_suppressed', code: cliErrorCode(error) }) + '\n')
      .catch(() => undefined);
  }
}
