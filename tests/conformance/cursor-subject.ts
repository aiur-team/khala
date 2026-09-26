import type { HarnessCapabilities } from '@khala/contracts/delivery/index';
import {
  CURSOR_ADAPTER_VERSION, CURSOR_HARNESS, type CursorInspection, createCursorHarness, cursorAppRecord,
} from '@khala/harnesses/cursor/index';
import type { SourceVersion } from '../e2e/harness/evidence';
import type { ModelInput } from '../e2e/harness/reference';
import { controlsFor, fixtureLimits } from './subjects';
import type { HarnessSubjectFactory, SuiteEnvironment } from './suites';

/** A fully inspected local Agent Chat. No committed proof covers it, so every mode is unknown. */
export const cursorInspection: CursorInspection = {
  shape: 'local_chat', appVersion: '1.7.4', accountTier: 'pro', administratorPolicyScope: 'personal-no-admin-policy',
};

export function cursorCapabilities(): HarnessCapabilities {
  return cursorAppRecord(cursorInspection, fixtureLimits).capabilities;
}

const sources: readonly SourceVersion[] = [
  { component: 'cursor-adapter', version: CURSOR_ADAPTER_VERSION },
  { component: 'cursor-app', version: cursorInspection.appVersion! },
];

export function cursorEnvironment(seeds: readonly string[]): SuiteEnvironment {
  return {
    mode: 'fake-contract',
    sources,
    owners: seeds.map(seed => ({ seed, controls: controlsFor(seed, CURSOR_HARNESS) })),
    limits: fixtureLimits,
  };
}

/** `push_into_chat` is the wrong implementation: it hands the release to the chat anyway. */
export type CursorHarnessDefect = 'push_into_chat';

export function cursorHarnessSubject(defect?: CursorHarnessDefect): HarnessSubjectFactory {
  return async () => {
    const modelInputs: ModelInput[] = [];
    const harness = createCursorHarness({
      probe: { inspect: async () => cursorInspection },
      clock: { now: () => new Date('2026-09-25T00:00:00.000Z') },
      limits: fixtureLimits,
    });
    const port = defect === 'push_into_chat' ? {
      ...harness,
      submit: async (input: Parameters<typeof harness.submit>[0]) => {
        const { job } = input;
        modelInputs.push({
          releaseId: job.releaseId,
          bindingId: job.binding.bindingId,
          sessionId: job.binding.sessionId,
          generation: job.binding.generation,
          payloadDigest: job.payloadDigest,
        });
        return harness.submit(input);
      },
    } : harness;
    return {
      mode: 'fake-contract',
      port,
      modelInputs: async () => [...modelInputs],
      receipts: async () => [],
      settle: async () => {},
      faults: [],
      close: () => harness.close(),
    };
  };
}
