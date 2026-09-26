import type { HarnessCapabilities } from '@khala/contracts/delivery/index';
import {
  CLAUDE_APP_ADAPTER_VERSION, CLAUDE_APP_HARNESS, type ClaudeAppEvidence, type ClaudeAppObservation, claudeAppRecord,
  createClaudeAppHarness,
} from '@khala/harnesses/claude-app/index';
import type { SourceVersion } from '../e2e/harness/evidence';
import type { ModelInput } from '../e2e/harness/reference';
import { controlsFor, fixtureLimits } from './subjects';
import type { HarnessSubjectFactory, SuiteEnvironment } from './suites';

export const claudeDesktop: ClaudeAppObservation = {
  shape: 'desktop_extension', appVersion: '0.14.10', accountTier: 'max', administratorPolicyScope: 'personal',
};
export const claudeBrowser: ClaudeAppObservation = { ...claudeDesktop, shape: 'browser', appVersion: '2026-09-25' };

export function claudeAppCapabilities(
  observation: ClaudeAppObservation,
  evidence?: readonly ClaudeAppEvidence[],
): HarnessCapabilities {
  return claudeAppRecord(observation, fixtureLimits, evidence).capabilities;
}

export function claudeAppEnvironment(observation: ClaudeAppObservation, seeds: readonly string[]): SuiteEnvironment {
  const sources: readonly SourceVersion[] = [
    { component: 'claude-app-adapter', version: CLAUDE_APP_ADAPTER_VERSION },
    { component: `claude-app-${observation.shape.replaceAll('_', '-')}`, version: observation.appVersion ?? 'unknown' },
  ];
  return {
    mode: 'fake-contract',
    sources,
    owners: seeds.map(seed => ({ seed, controls: controlsFor(seed, CLAUDE_APP_HARNESS) })),
    limits: fixtureLimits,
  };
}

/** `push_before_refusal` writes the batch into the model before refusing, as a polling shim would. */
export type ClaudeAppHarnessDefect = 'push_before_refusal';

export function claudeAppHarnessSubject(
  observation: ClaudeAppObservation,
  defect?: ClaudeAppHarnessDefect,
): HarnessSubjectFactory {
  return async () => {
    const modelInputs: ModelInput[] = [];
    const harness = createClaudeAppHarness({
      observe: async () => observation,
      clock: { now: () => new Date('2026-09-25T00:00:00.000Z') },
      limits: fixtureLimits,
    });
    const port = defect === 'push_before_refusal' ? {
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
