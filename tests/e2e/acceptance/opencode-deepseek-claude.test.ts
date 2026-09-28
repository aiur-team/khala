// AC5 offline contract checks. A passing scripted world checks runner wiring,
// never claims that a real OpenCode/DeepSeek and Claude exchange occurred.

import { describe, expect, it } from 'vitest';
import { openCodeDeepSeekClaudeDocument, openCodeDeepSeekClaudeProfile } from '../../../scripts/acceptance/profiles/opencode-deepseek-claude';
import { decodeProfile, planModes } from '../../../scripts/acceptance/profile';
import { runAcceptance } from '../../../scripts/acceptance/runner';
import type { Profile, RunReport } from '../../../scripts/acceptance/types';
import { RUN_ID, createWorld } from './fakes';

const profile = () => openCodeDeepSeekClaudeProfile({
  khalaPackage: '@aiur/khala@0.4.0', openCodeModel: 'deepseek/deepseek-flash', claudeModel: 'opus',
});

async function run(candidate: Profile = profile(), knobs: Parameters<typeof createWorld>[0] = {}): Promise<RunReport> {
  const world = createWorld(knobs, candidate);
  return runAcceptance(world.deps, { profile: world.profile, runId: RUN_ID, resume: null });
}

describe('AC5 OpenCode DeepSeek and Claude profile', () => {
  it('pins separate native routes, providers and versions and runs only shared proven modes', async () => {
    const candidate = profile();
    expect(candidate.roles.map(role => [role.harness, role.provider, role.model, role.cliVersion])).toEqual([
      ['opencode', 'deepseek', 'deepseek/deepseek-flash', '1.17.10'],
      ['claude', 'anthropic', 'opus', '2.1.283'],
    ]);
    expect(candidate.roles.every(role => role.capabilities.existingSession !== 'khala_hosted_resume')).toBe(true);
    expect(planModes(candidate).runnable).toEqual(['steer', 'async']);
    expect(planModes(candidate).skipped).toMatchObject([{ mode: 'sync' }]);
    const document = openCodeDeepSeekClaudeDocument({
      khalaPackage: '@aiur/khala@0.4.0', openCodeModel: 'deepseek/deepseek-flash', claudeModel: 'opus',
    });
    expect(decodeProfile(JSON.parse(JSON.stringify(document)))).toEqual(candidate);
    const report = await run(candidate);
    expect(report.verdict).toBe('pass');
    expect(report.roles.map(role => role.session?.harness)).toEqual(['opencode', 'claude']);
    expect(report.checks.filter(check => check.status !== 'pass')).toEqual([]);
  });

  it('refuses direct DeepSeek, a second OpenCode agent, and unpinned builds at profile creation', () => {
    expect(() => openCodeDeepSeekClaudeProfile({
      khalaPackage: '@aiur/khala@0.4.0', openCodeModel: 'deepseek-direct', claudeModel: 'opus',
    })).toThrow(/DeepSeek provider model/);
    expect(() => openCodeDeepSeekClaudeProfile({
      khalaPackage: '@aiur/khala@0.4.0', openCodeModel: 'deepseek/deepseek-flash', claudeModel: 'deepseek/deepseek-flash',
    })).toThrow(/Claude model/);
    expect(() => openCodeDeepSeekClaudeProfile({
      khalaPackage: '@aiur/khala@latest', openCodeModel: 'deepseek/deepseek-flash', claudeModel: 'opus',
    })).toThrow(/khalaPackage/);
  });

  it('fails mismatched provider, hosted secondary session and a Stop that revokes nothing', async () => {
    const candidate = profile();
    const world = createWorld({}, candidate);
    const captured = world.deps.aiur.capturedSession;
    const current = world.deps.aiur.session;
    const forged = await runAcceptance({ ...world.deps, aiur: {
      ...world.deps.aiur,
      async capturedSession(ticket, runId, role) {
        const session = await captured(ticket, runId, role);
        return role === 'a' && session ? { ...session, provider: 'anthropic' } : session;
      },
      async session(ticket, runId, role) {
        const session = await current(ticket, runId, role);
        return role === 'a' && session ? { ...session, provider: 'anthropic' } : session;
      },
    } }, { profile: candidate, runId: RUN_ID, resume: null });
    expect(forged.verdict).not.toBe('pass');
    expect(forged.checks.find(check => check.check === 'native-session:a')?.status).toBe('fail');

    const hosted = createWorld({}, candidate);
    const hostedCaptured = hosted.deps.aiur.capturedSession;
    const hostedCurrent = hosted.deps.aiur.session;
    const hostedReport = await runAcceptance({ ...hosted.deps, aiur: {
      ...hosted.deps.aiur,
      async capturedSession(ticket, runId, role) {
        const session = await hostedCaptured(ticket, runId, role);
        return role === 'b' && session ? { ...session, harness: 'claude-hosted' } : session;
      },
      async session(ticket, runId, role) {
        const session = await hostedCurrent(ticket, runId, role);
        return role === 'b' && session ? { ...session, harness: 'claude-hosted' } : session;
      },
    } }, { profile: candidate, runId: RUN_ID, resume: null });
    expect(hostedReport.verdict).not.toBe('pass');

    const noStop = await run(candidate, { deliverAfterStop: true });
    expect(noStop.verdict).not.toBe('pass');
    expect(noStop.checks.find(check => check.check === 'no-delivery-after-stop')?.status).toBe('fail');
  });

  it('keeps an unconfirmed supported mode unproven and closes owned tickets after a cleanup failure', async () => {
    const candidate = profile();
    const unsupported = await run(candidate, { mode: mode => mode === 'async'
      ? { kind: 'unsupported', reason: 'no native route' } : { kind: 'effective' } });
    expect(unsupported.verdict).toBe('unproven');
    expect(unsupported.checks.find(check => check.check === 'handshake:async')?.status).toBe('unproven');
    const cleanup = await run(candidate, { stopThrows: true });
    expect(cleanup.verdict).not.toBe('pass');
    expect(cleanup.launcherClosed).toBe(true);
    expect(cleanup.cleanup.map(entry => entry.outcome)).toEqual(['closed', 'closed']);
  });

});
