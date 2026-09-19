import type { HarnessCapabilities } from '@khala/contracts/delivery/index';
import {
  CLAUDE_ADAPTER_VERSION, CLAUDE_EVIDENCE_REF, CLAUDE_HARNESS, CLAUDE_TESTED_VERSION, createClaudeHarness,
} from '@khala/harnesses/claude/index';
import type { SourceVersion } from '../e2e/harness/evidence';
import type { ModelInput } from '../e2e/harness/reference';
import { controlsFor, fixtureLimits } from './subjects';
import type { HarnessSubjectFactory, SuiteEnvironment } from './suites';

export function claudeCapabilities(): HarnessCapabilities {
  return {
    v: 2,
    harness: CLAUDE_HARNESS,
    version: CLAUDE_TESTED_VERSION,
    adapterVersion: CLAUDE_ADAPTER_VERSION,
    support: 'unsupported',
    existingSession: 'unsupported',
    immediateNotification: 'unsupported',
    busy: 'unknown',
    receiptEvidence: ['failed'],
    reconcileByReleaseId: 'unsupported',
    limits: fixtureLimits,
    evidenceRef: CLAUDE_EVIDENCE_REF,
  };
}

const sources: readonly SourceVersion[] = [
  { component: 'claude-adapter', version: CLAUDE_ADAPTER_VERSION },
  { component: 'claude-native-proof', version: CLAUDE_TESTED_VERSION },
];

export function claudeEnvironment(seeds: readonly string[]): SuiteEnvironment {
  return {
    mode: 'fake-contract',
    sources,
    owners: seeds.map(seed => ({ seed, controls: controlsFor(seed, CLAUDE_HARNESS) })),
    limits: fixtureLimits,
  };
}

export function claudeHarnessSubject(): HarnessSubjectFactory {
  return async (_scenario, owner) => {
    const modelInputs: ModelInput[] = [];
    const harness = createClaudeHarness({
      probe: {
        installedVersion: async () => CLAUDE_TESTED_VERSION,
        session: async sessionId => sessionId === owner.binding.sessionId ? 'present' : 'absent',
      },
      route: {
        submit: async ({ job }) => {
          modelInputs.push({
            releaseId: job.releaseId,
            bindingId: job.binding.bindingId,
            sessionId: job.binding.sessionId,
            generation: job.binding.generation,
            payloadDigest: job.payloadDigest,
          });
          return { status: 'accepted', evidenceRef: `route:${job.releaseId}` };
        },
      },
      clock: { now: () => new Date('2026-09-18T00:00:00.000Z') },
      limits: fixtureLimits,
    });
    return {
      mode: 'fake-contract',
      port: harness,
      modelInputs: async () => [...modelInputs],
      receipts: async () => [],
      settle: async () => {},
      faults: [],
      close: () => harness.close(),
    };
  };
}
