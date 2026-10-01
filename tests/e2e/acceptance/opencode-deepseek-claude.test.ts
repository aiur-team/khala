// AC5 offline contract checks. The scripted world supplies a scoped provider
// process observation to exercise runner wiring; it is not live acceptance proof.

import { describe, expect, it } from 'vitest';
import { decodeDeliveryLimits } from '../../../packages/contracts/src/delivery/decode';
import { installedClaudeCapabilities } from '../../../packages/harnesses/src/claude/interactive';
import { installedOpenCodeCapabilities } from '../../../packages/harnesses/src/opencode/interactive';
import {
  CLAUDE_VERSION, OPENCODE_VERSION, openCodeDeepSeekClaudeDocument, openCodeDeepSeekClaudeProfile,
} from '../../../scripts/acceptance/profiles/opencode-deepseek-claude';
import { decodeProfile, planModes } from '../../../scripts/acceptance/profile';
import { runAcceptance } from '../../../scripts/acceptance/runner';
import type { Profile, RunReport } from '../../../scripts/acceptance/types';
import { RUN_ID, createWorld } from './fakes';

const input = () => ({
  khalaPackage: '@aiur/khala@0.4.0', openCodeModel: 'deepseek/deepseek-flash', claudeModel: 'opus',
});

const decodedLimits = decodeDeliveryLimits({ maxPayloadBytes: 65_536, maxSelectionEvents: 32 });
if (!decodedLimits.ok) throw new Error('AC5 offline fixture: invalid delivery limits');
const limits = decodedLimits.value;

function profile(sameSession = true): Profile {
  const scope = { sessionId: 'scripted-claude-session', bindingId: 'scripted-claude-binding', generation: 1 };
  const processEvidence = { ...scope, sessionId: sameSession ? scope.sessionId : 'foreign-claude-session',
    source: 'provider_process' as const, version: CLAUDE_VERSION, processId: 1 };
  return decodeProfile({
    name: 'opencode-deepseek-claude', repository: 'aiur-team/khala', dispatchLabel: 'agent:todo',
    khalaPackage: input().khalaPackage, timeoutMs: 20 * 60_000,
    roles: [
      { role: 'a', harness: 'opencode', provider: 'deepseek', model: input().openCodeModel,
        cliVersion: OPENCODE_VERSION, capabilities: installedOpenCodeCapabilities(OPENCODE_VERSION, limits) },
      { role: 'b', harness: 'claude', provider: 'anthropic', model: input().claudeModel,
        cliVersion: CLAUDE_VERSION,
        capabilities: installedClaudeCapabilities(CLAUDE_VERSION, limits, processEvidence, scope) },
    ],
  });
}

async function run(candidate: Profile = profile(), knobs: Parameters<typeof createWorld>[0] = {}): Promise<RunReport> {
  const world = createWorld(knobs, candidate);
  return runAcceptance(world.deps, { profile: world.profile, runId: RUN_ID, resume: null });
}

describe('AC5 OpenCode DeepSeek and Claude profile', () => {
  it('refuses the live profile and document without shared proven same-session evidence', () => {
    expect(() => openCodeDeepSeekClaudeProfile(input())).toThrow('AC5 profile: no shared proven mode');
    expect(() => openCodeDeepSeekClaudeDocument(input())).toThrow('AC5 profile: no shared proven mode');
    expect(planModes(profile(false)).runnable).toEqual([]);
  });

  it('pins separate native routes, providers and versions and runs only shared proven modes', async () => {
    const candidate = profile();
    expect(candidate.roles.map(role => [role.harness, role.provider, role.model, role.cliVersion])).toEqual([
      ['opencode', 'deepseek', 'deepseek/deepseek-flash', '1.17.10'],
      ['claude', 'anthropic', 'opus', '2.1.283'],
    ]);
    expect(candidate.roles.every(role => role.capabilities.existingSession !== 'khala_hosted_resume')).toBe(true);
    expect(planModes(candidate).runnable).toEqual(['steer', 'async']);
    expect(planModes(candidate).skipped).toMatchObject([{ mode: 'sync' }]);
    expect(decodeProfile(JSON.parse(JSON.stringify({ ...candidate, khalaPackage: input().khalaPackage })))).toEqual(candidate);
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
