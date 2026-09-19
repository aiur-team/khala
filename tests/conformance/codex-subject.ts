// The real Codex harness adapter (KHA-118) as a conformance subject, running against
// the package's fake app-server. This is `fake-contract` evidence about the real
// adapter code: the app-server is a model of KHA-104's observations, not a live Codex.
//
// Faults are enacted at the adapter's native seams:
// - `session_exit`: the host registry loses the executor when the release arrives.
// - `session_busy`: the thread is running a turn when the release arrives.
// - `disconnect_after_write`: `thread/queue/add` reaches the queue but its reply is lost.
// Each seam calls `checkpoint` at the fault's boundary, so an injected fault that the
// adapter never reaches is reported unfired.

import type { DeliveryReceipt, HarnessCapabilities, HarnessPort } from '@khala/contracts/delivery/index';
import {
  CODEX_ADAPTER_VERSION, CODEX_EVIDENCE_REF, CODEX_HARNESS, CODEX_RECEIPT_EVIDENCE, type Clock, type EvidenceSink,
  TESTED_CODEX_VERSIONS, createCodexHarness, createCodexReceiptTracker,
} from '@khala/harnesses/codex/index';
// The package withholds `codex/fakes` from its exports; the suite reuses its fake
// app-server by path rather than writing a second model of the native behaviour.
import { FakeAppServer, FakeCodec, FakeHosts } from '../../packages/harnesses/src/codex/fakes';
import type { SourceVersion } from '../e2e/harness/evidence';
import { type Fault, InjectedDisconnect } from '../e2e/harness/faults';
import { type ModelInput, sha256 } from '../e2e/harness/reference';
import { controlsFor, fixtureLimits } from './subjects';
import type { HarnessSubjectFactory, SuiteEnvironment } from './suites';

const CODEX_VERSION = TESTED_CODEX_VERSIONS[0]!;
const FAKE_EPOCH_MS = Date.UTC(2026, 8, 18);

/** The capability record the adapter must report for a healthy tested host, stated independently. */
export function codexCapabilities(): HarnessCapabilities {
  return {
    v: 2,
    harness: CODEX_HARNESS,
    version: CODEX_VERSION,
    adapterVersion: CODEX_ADAPTER_VERSION,
    support: 'tested',
    existingSession: 'khala_hosted_resume',
    immediateNotification: 'khala_hosted_idle',
    busy: 'queue',
    receiptEvidence: [...CODEX_RECEIPT_EVIDENCE],
    reconcileByReleaseId: 'while_queued',
    limits: fixtureLimits,
    evidenceRef: CODEX_EVIDENCE_REF,
  };
}

export const codexSources: readonly SourceVersion[] = [
  { component: 'codex-adapter', version: CODEX_ADAPTER_VERSION },
  { component: 'codex-fake-app-server', version: CODEX_VERSION },
];

export function codexEnvironment(seeds: readonly string[]): SuiteEnvironment {
  return {
    mode: 'fake-contract',
    sources: codexSources,
    owners: seeds.map(seed => ({ seed, controls: controlsFor(seed, CODEX_HARNESS) })),
    limits: fixtureLimits,
  };
}

const CODEX_FAULTS: readonly Fault[] = ['disconnect_after_write', 'session_exit', 'session_busy'];

export function codexHarnessSubject(): HarnessSubjectFactory {
  return async (scenario, owner) => {
    const { ownerId, binding } = owner;
    const workdir = scenario.stateDir(ownerId);
    const server = new FakeAppServer();
    server.threadId = binding.sessionId;
    server.cwd = workdir;
    const hosts = new FakeHosts({
      binding, workdir, cliVersion: CODEX_VERSION, endpoint: { kind: 'unix', path: `/run/khala/codex/${binding.bindingId}/exec.sock` },
    });
    const clock: Clock = { now: () => new Date(FAKE_EPOCH_MS + Math.floor(scenario.clock(ownerId).now())) };
    const evidence: EvidenceSink = {
      record: async receipt => {
        scenario.record(`receipt.${receipt.kind}`, { ownerId, operationId: receipt.releaseId });
      },
    };
    const harness = createCodexHarness({
      client: server, hosts, codec: new FakeCodec(), clock, evidence, limits: fixtureLimits, deadlines: { callMs: 1_000, closeMs: 2_000 },
    });
    const tracker = createCodexReceiptTracker(binding, clock);
    const inputs: ModelInput[] = [];
    const streamed: DeliveryReceipt[] = [];

    const port: HarnessPort = {
      inspect: target => harness.inspect(target),
      notify: (target, hint) => harness.notify(target, hint),
      async submit(input) {
        // The executor's state at the moment a release arrives.
        const fault = scenario.faults.checkpoint('harness.accept', ownerId, input.job.releaseId);
        if (fault === 'session_exit') hosts.host = null;
        if (fault === 'session_busy') server.status = 'active';
        // Composition (KHA-133) tracks each submitted release on the host's listener.
        tracker.track(input.job);
        return harness.submit(input);
      },
      reconcile: job => harness.reconcile(job),
      close: () => harness.close(),
    };

    return {
      mode: 'fake-contract',
      port,
      faults: CODEX_FAULTS,
      async inject(fault) {
        if (fault !== 'disconnect_after_write') return;
        server.override('thread/queue/add', params => {
          const releaseId = String(params.clientUserMessageId);
          try {
            scenario.faults.checkpoint('transport.after_write', ownerId, releaseId);
            return undefined;
          } catch (error) {
            if (!(error instanceof InjectedDisconnect)) throw error;
            // The entry reached the native queue; only the reply is lost.
            const [first] = params.input as { text: string }[];
            server.queue.push({ id: `q-lost-${releaseId}`, clientUserMessageId: releaseId, text: first!.text });
            return { status: 'lost', written: true, cause: 'disconnected' };
          }
        });
      },
      async settle() {
        if (scenario.faults.isArmed('session_busy', ownerId)) scenario.faults.clear('session_busy', ownerId);
        server.status = 'idle';
        // The executor takes queued entries in order, one turn each, and the listener
        // reports the user message and the turn's completion.
        while (server.queue.length > 0) {
          const entry = server.queue[0]!;
          server.consumeNext();
          const turn = server.turns.at(-1)!;
          inputs.push({
            releaseId: entry.clientUserMessageId,
            bindingId: binding.bindingId,
            sessionId: server.threadId,
            generation: binding.generation,
            payloadDigest: sha256(new TextEncoder().encode(entry.text)),
          });
          scenario.record('model.input', { ownerId, operationId: entry.clientUserMessageId });
          const threadId = server.threadId;
          streamed.push(
            ...tracker.observe({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'userMessage', id: `${turn.id}-u0`, clientId: entry.clientUserMessageId } } }),
            ...tracker.observe({ method: 'turn/completed', params: { threadId, turn: { id: turn.id, status: 'completed' } } }),
          );
        }
      },
      modelInputs: async () => [...inputs],
      receipts: async () => [...streamed],
      close: () => harness.close(),
    };
  };
}
