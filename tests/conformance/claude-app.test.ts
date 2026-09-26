import { claudeAppIdentity, type ClaudeAppEvidence } from '@khala/harnesses/claude-app/index';
import { describe, expect, it } from 'vitest';
import {
  claudeAppCapabilities, claudeAppEnvironment, claudeAppHarnessSubject, claudeBrowser, claudeDesktop,
} from './claude-app-subject';
import { outcomeOf, runHarnessConformance } from './suites';

const row = (overrides: Partial<ClaudeAppEvidence>): ClaudeAppEvidence => ({
  identity: claudeAppIdentity(claudeDesktop),
  mode: 'async',
  boundary: 'khala_read',
  delivery: 'khala_read_result',
  route: 'claude-app-desktop-extension-khala-read',
  evidenceRef: 'experiments/interactive-cli/claude-app/evidence/desktop_extension/verdict.json',
  evidenceRevision: 'claude-app-conformance',
  ...overrides,
});

describe('harness conformance: fail-closed Claude app adapter', () => {
  for (const observation of [claudeDesktop, claudeBrowser]) {
    it(`refuses every push for ${observation.shape}`, async () => {
      const capabilities = claudeAppCapabilities(observation);
      expect(capabilities.support).toBe('unsupported');
      const report = await runHarnessConformance(
        claudeAppHarnessSubject(observation), capabilities, claudeAppEnvironment(observation, ['b', 'c', 'a']),
      );
      expect(report.results.filter(result => result.outcome.status === 'fail')).toEqual([]);
      expect(outcomeOf(report, 'capabilities.declared')).toEqual({ status: 'pass' });
      expect(outcomeOf(report, 'support.fail_closed')).toEqual({ status: 'pass' });
    });
  }

  it('rejects an adapter that pushes content before refusing', async () => {
    const report = await runHarnessConformance(
      claudeAppHarnessSubject(claudeDesktop, 'push_before_refusal'),
      claudeAppCapabilities(claudeDesktop),
      claudeAppEnvironment(claudeDesktop, ['b', 'c', 'a']),
    );
    expect(outcomeOf(report, 'support.fail_closed').status).toBe('fail');
  });
});

describe('claude-app-channel-adapter wrong-implementation tests', () => {
  it('an MCP notification, tool-list change, or second session never promotes steer', () => {
    for (const delivery of ['mcp_notification', 'tool_list_changed', 'second_session'] as const) {
      const capabilities = claudeAppCapabilities(claudeDesktop, [
        row({ mode: 'steer', boundary: 'PostToolUse', delivery, route: `claude-app-${delivery}` }),
      ]);
      expect(capabilities.modes.steer.status).toBe('unknown');
      expect(capabilities.support).toBe('unsupported');
    }
  });

  it('absent push proof never maps sync to polling', () => {
    const polled = claudeAppCapabilities(claudeDesktop, [
      row({ mode: 'sync', boundary: 'Stop', delivery: 'polling', route: 'claude-app-poll' }),
    ]);
    expect(polled.modes.sync).toMatchObject({ status: 'unknown', route: 'claude-app-desktop_extension-sync' });
    expect(polled.modes.sync.reason).toMatch(/polling is not sync/);
    // A proven pull route leaves sync unknown rather than standing in for it.
    const pullOnly = claudeAppCapabilities(claudeDesktop, [row({})]);
    expect(pullOnly.modes.async.status).toBe('proven');
    expect(pullOnly.modes.sync.status).toBe('unknown');
  });

  it('keeps desktop and browser records separate', () => {
    const desktopProof = [row({})];
    expect(claudeAppCapabilities(claudeDesktop, desktopProof).modes.async.status).toBe('proven');
    expect(claudeAppCapabilities({ ...claudeDesktop, shape: 'browser' }, desktopProof).modes.async.status).toBe('unknown');
    expect(claudeAppCapabilities(claudeBrowser, desktopProof).modes.async.status).toBe('unknown');
  });
});
