import { createHash } from 'node:crypto';
import path from 'node:path';
import { type HarnessCapabilities, type HarnessPort, type ReleasedJob, sameSessionBinding } from '@khala/contracts/delivery/index';
import type { SessionClaim, SessionInspectionPort } from '@khala/connector/bootstrap/index';
import { createCodexHarness, createCodexQueueProcessPort, type CodexNativeCliPort } from '@khala/harnesses/codex/index';
import { CODEX_IDLE_WAKE_NOTICE } from '@khala/harnesses/codex/idle-wake';
import { unsupportedNativeCliCapabilities } from '@khala/harnesses/codex/capabilities';
import { encodeReleasePayload } from '@khala/policy/release/index';
import { encodeMessageContent } from '@khala/contracts/messaging/events';
import type { SessionBinding } from '@khala/contracts/delivery/index';

export type LocalInbox = Readonly<{
  enqueue(delivery: Readonly<{ v: 1; releaseId: string; bindingId: string; generation: number;
    events: ReleasedJob['events']; payloadDigest: string; payload: Uint8Array; receivedAt: string }>): Promise<'appended' | 'duplicate'>;
  notifyListener(reason: 'released'): Promise<'notified' | 'unavailable'>;
}>;

/** The installed Codex adapter uses only exact provider-named session evidence. */
export function createHostedCodexHarness(input: Readonly<{
  binding: SessionBinding;
  claim: SessionClaim;
  sessionInspection: SessionInspectionPort;
  current(): Promise<boolean>;
  resolveExecutable(): Promise<string | null>;
  inspectHooks(): Promise<HarnessCapabilities | null>;
  openInbox(bindingId: string, generation: number): Promise<LocalInbox>;
}>): HarnessPort {
  const clock = { now: () => new Date() };
  const limits = { maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 };
  const nativeCli: CodexNativeCliPort = {
    async inspect(sessionId) {
      if (sessionId !== input.binding.sessionId || !await input.current()) return {
        version: null, session: 'not_owned', bindingId: null, generation: null,
        platform: process.platform, arch: process.arch,
      };
      const inspected = await input.sessionInspection.inspect(input.claim);
      if (inspected.kind !== 'verified' || inspected.session.harness !== input.binding.harness
        || inspected.session.sessionId !== input.binding.sessionId
        || inspected.session.generation !== input.binding.generation) return {
        version: null, session: 'not_owned', bindingId: null, generation: null,
        platform: process.platform, arch: process.arch,
      };
      return { version: inspected.capabilities.version, session: 'present',
        bindingId: input.binding.bindingId, generation: input.binding.generation,
        platform: process.platform, arch: process.arch };
    },
    async run(argv) {
      if (argv.length !== 5 || argv[0] !== 'queue' || argv[1] !== '--thread'
        || argv[2] !== input.binding.sessionId || argv[3] !== '--message'
        || argv[4] !== CODEX_IDLE_WAKE_NOTICE || !await input.current()) return { status: 'not_started' };
      const executable = await input.resolveExecutable();
      if (!executable || !path.isAbsolute(executable)) return { status: 'not_started' };
      const abort = new AbortController();
      const port = createCodexQueueProcessPort({ command: executable, env: process.env, timeoutMs: 10_000 });
      const outcome = await port.run(argv, abort.signal);
      return outcome.status === 'queued' ? { status: 'queued', queueId: 'codex-queue-exit-zero' }
        : outcome;
    },
  };

  const core = createCodexHarness({
    hosts: { lookup: async () => null },
    client: { connect: async () => null },
    nativeCli,
    nativeInbox: {
      async enqueue(delivery) {
        if (delivery.bindingId !== input.binding.bindingId || delivery.generation !== input.binding.generation) {
          throw new Error('hosted_inbox_binding_mismatch');
        }
        if (!await input.current()) throw new Error('hosted_binding_revoked');
        const inbox = await input.openInbox(input.binding.bindingId, input.binding.generation);
        const result = await inbox.enqueue(delivery);
        if (result === 'appended') await inbox.notifyListener('released').catch(() => 'unavailable' as const);
        return result;
      },
    },
    codec: { verify: verifyReleasePayload },
    clock, evidence: { record: async () => undefined },
    limits: limits as never,
    deadlines: { callMs: 12_000, closeMs: 15_000 },
  });

  return {
    async inspect(binding) {
      if (!sameSessionBinding(binding, input.binding) || !await input.current()) {
        return unsupportedNativeCliCapabilities('unknown', limits as never);
      }
      const native = await core.inspect(binding);
      if (native.support !== 'tested' || native.existingSession !== 'native_cli_queue') return native;
      const hooks = await input.inspectHooks();
      if (!hooks || hooks.support !== 'tested' || hooks.harness !== 'codex' || hooks.version !== native.version) return native;
      return { ...native, modes: hooks.modes, acknowledgement: hooks.acknowledgement };
    },
    notify: (binding, hint) => core.notify(binding, hint),
    submit: command => core.submit(command),
    reconcile: async job => await input.current() ? core.reconcile(job) : null,
    close: () => core.close(),
  };
}

async function verifyReleasePayload(job: ReleasedJob, bytes: Uint8Array): Promise<'ok' | 'digest_mismatch' | 'event_mismatch'> {
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== job.payloadDigest) return 'digest_mismatch';
  let tuple: unknown;
  try { tuple = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown; }
  catch { return 'event_mismatch'; }
  if (!Array.isArray(tuple) || tuple.length !== 6 || tuple[0] !== 'khala.release.v1'
    || tuple[1] !== job.releaseId || tuple[2] !== job.binding.bindingId
    || tuple[3] !== job.binding.generation || tuple[4] !== job.policyVersion
    || !Array.isArray(tuple[5]) || tuple[5].length !== job.events.length) return 'event_mismatch';
  const items: Array<{ ref: ReleasedJob['events'][number]; content: { v: 1; kind: 'text'; body: string } }> = [];
  for (const [index, value] of tuple[5].entries()) {
    if (!Array.isArray(value) || value.length !== 6 || typeof value[5] !== 'string') return 'event_mismatch';
    const ref = job.events[index]!;
    const row = [ref.roomId, ref.eventId, ref.authorParticipantId, ref.authorDeviceId, ref.contentDigest];
    if (row.some((field, position) => field !== value[position])) return 'event_mismatch';
    const content = { v: 1 as const, kind: 'text' as const, body: value[5] };
    const digest = `sha256:${createHash('sha256').update(encodeMessageContent(content)).digest('hex')}`;
    if (digest !== ref.contentDigest) return 'event_mismatch';
    items.push({ ref, content });
  }
  const canonical = encodeReleasePayload({ releaseId: job.releaseId, bindingId: job.binding.bindingId,
    generation: job.binding.generation, policyVersion: job.policyVersion, items });
  return canonical.ok && Buffer.from(canonical.bytes).equals(Buffer.from(bytes)) ? 'ok' : 'event_mismatch';
}
