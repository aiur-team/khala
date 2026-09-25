import { type DeliveryReceipt, type HarnessCapabilities, type HarnessPort, unknownModeSupportMap } from '@khala/contracts/delivery/index';
import {
  CODEX_HARNESS, CODEX_NATIVE_CLI_ADAPTER_VERSION, CODEX_NATIVE_CLI_EVIDENCE_REF,
  CODEX_NATIVE_CLI_RECEIPT_EVIDENCE, TESTED_CODEX_VERSIONS, type CodexNativeCliOutcome,
  type CodexNativeCliPort, type CodexNativeInboxDelivery, type CodexNativeInboxPort,
  type Clock, type EvidenceSink, createCodexHarness,
} from '@khala/harnesses/codex/index';
import { FakeAppServer, FakeCodec, FakeHosts } from '../../packages/harnesses/src/codex/fakes';
import type { SourceVersion } from '../e2e/harness/evidence';
import { type Fault, InjectedDisconnect } from '../e2e/harness/faults';
import type { ModelInput } from '../e2e/harness/reference';
import { controlsFor, fixtureLimits } from './subjects';
import type { HarnessSubjectFactory, SuiteEnvironment } from './suites';

const CODEX_VERSION = TESTED_CODEX_VERSIONS[0]!;
const FAKE_EPOCH_MS = Date.UTC(2026, 8, 18);

export function codexNativeCapabilities(): HarnessCapabilities {
  return {
    v: 3,
    harness: CODEX_HARNESS,
    version: CODEX_VERSION,
    adapterVersion: CODEX_NATIVE_CLI_ADAPTER_VERSION,
    support: 'tested',
    existingSession: 'native_cli_queue',
    immediateNotification: 'native_cli_queue',
    busy: 'queue',
    receiptEvidence: [...CODEX_NATIVE_CLI_RECEIPT_EVIDENCE],
    reconcileByReleaseId: 'unsupported',
    limits: fixtureLimits,
    evidenceRef: CODEX_NATIVE_CLI_EVIDENCE_REF,
    modes: unknownModeSupportMap(
      'codex-interactive-native',
      'The native queue proves notification only; idle agents receive messages only at their next turn until payload delivery is proved.',
      CODEX_VERSION,
    ),
    acknowledgement: 'unknown',
  };
}

const nativeSources: readonly SourceVersion[] = [
  { component: 'codex-native-cli-adapter', version: CODEX_NATIVE_CLI_ADAPTER_VERSION },
  { component: 'codex-native-cli', version: CODEX_VERSION },
];

export function codexNativeEnvironment(seeds: readonly string[]): SuiteEnvironment {
  return {
    mode: 'fake-contract',
    sources: nativeSources,
    owners: seeds.map(seed => ({ seed, controls: controlsFor(seed, CODEX_HARNESS) })),
    limits: fixtureLimits,
  };
}

const NATIVE_FAULTS: readonly Fault[] = ['disconnect_after_write', 'session_busy'];

export function codexNativeHarnessSubject(): HarnessSubjectFactory {
  return async (scenario, owner) => {
    const { ownerId, binding } = owner;
    const deliveries = new Map<string, CodexNativeInboxDelivery>();
    const queued: string[] = [];
    let latestRelease: string | null = null;
    let busy = false;

    const inbox: CodexNativeInboxPort = {
      async enqueue(delivery) {
        latestRelease = delivery.releaseId;
        if (deliveries.has(delivery.releaseId)) return 'duplicate';
        deliveries.set(delivery.releaseId, delivery);
        return 'appended';
      },
    };
    const cli: CodexNativeCliPort = {
      async inspect(sessionId) {
        return {
          version: CODEX_VERSION,
          session: sessionId === binding.sessionId ? 'present' : 'absent',
          bindingId: binding.bindingId,
          generation: binding.generation,
          platform: 'linux',
          arch: 'x64',
        };
      },
      async run() {
        if (latestRelease === null) return { status: 'not_started' };
        const releaseId = latestRelease;
        latestRelease = null;
        try {
          scenario.faults.checkpoint('transport.after_write', ownerId, releaseId);
        } catch (error) {
          if (!(error instanceof InjectedDisconnect)) throw error;
          queued.push(releaseId);
          return { status: 'lost', cause: 'disconnected' } satisfies CodexNativeCliOutcome;
        }
        queued.push(releaseId);
        return { status: 'queued', queueId: `native-${releaseId}` };
      },
    };
    const hosts = new FakeHosts();
    hosts.host = null;
    const clock: Clock = { now: () => new Date(FAKE_EPOCH_MS + Math.floor(scenario.clock(ownerId).now())) };
    const evidence: EvidenceSink = { record: async receipt => {
      scenario.record(`receipt.${receipt.kind}`, { ownerId, operationId: receipt.releaseId });
    } };
    const harness = createCodexHarness({
      client: new FakeAppServer(), hosts, codec: new FakeCodec(), clock, evidence,
      limits: fixtureLimits, deadlines: { callMs: 1_000, closeMs: 2_000 }, nativeCli: cli, nativeInbox: inbox,
    });
    await harness.inspect(binding);
    const inputs: ModelInput[] = [];

    const port: HarnessPort = {
      inspect: target => harness.inspect(target),
      notify: (target, hint) => harness.notify(target, hint),
      async submit(input) {
        const fault = scenario.faults.checkpoint('harness.accept', ownerId, input.job.releaseId);
        if (fault === 'session_busy') busy = true;
        return harness.submit(input);
      },
      reconcile: job => harness.reconcile(job),
      close: () => harness.close(),
    };

    return {
      mode: 'fake-contract',
      port,
      faults: NATIVE_FAULTS,
      async inject() {},
      async settle() {
        if (scenario.faults.isArmed('session_busy', ownerId)) scenario.faults.clear('session_busy', ownerId);
        busy = false;
        while (!busy && queued.length > 0) {
          const releaseId = queued.shift()!;
          const delivery = deliveries.get(releaseId);
          if (!delivery) continue;
          inputs.push({
            releaseId: delivery.releaseId,
            bindingId: delivery.bindingId,
            sessionId: binding.sessionId,
            generation: delivery.generation,
            payloadDigest: delivery.payloadDigest,
          });
          scenario.record('model.input', { ownerId, operationId: delivery.releaseId });
        }
      },
      modelInputs: async () => [...inputs],
      receipts: async (): Promise<readonly DeliveryReceipt[]> => [],
      close: () => harness.close(),
    };
  };
}
