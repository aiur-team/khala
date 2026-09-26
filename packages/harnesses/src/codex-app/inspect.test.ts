import { decodeAppHarnessRecord, decodeHarnessCapabilities } from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import proofRecord from '../../../../experiments/interactive-cli/codex-app/evidence/cells.json';
import { limits } from '../codex/fakes';
import {
  CODEX_APP_BOUNDARIES, CODEX_APP_PROOF_RECORD, CODEX_APP_PROVEN_CELLS, CODEX_APP_SHAPES, type CodexAppProvenCell,
} from './evidence';
import type { CodexAppCensus } from './census';
import { type CodexAppEnvironment, codexAppIdentity, inspectCodexApp } from './inspect';

const MODES = ['steer', 'sync', 'async'] as const;

/** A user-started desktop app whose Codex session process is pid 30, with the Khala hook as its child. */
function census(session: readonly string[] = ['codex'], root: readonly string[] = ['/usr/lib/systemd/systemd', '--user']): CodexAppCensus {
  return {
    sessionPid: 30,
    processes: [
      { pid: 10, ppid: 1, argv: root },
      { pid: 20, ppid: 10, argv: ['/opt/Codex/Codex'] },
      { pid: 30, ppid: 20, argv: session },
      { pid: 40, ppid: 30, argv: ['khala', 'codex-app-hook'] },
    ],
  };
}

/** A session whose route would be active if a proof covered its exact tuple. */
function environment(overrides: Partial<CodexAppEnvironment> = {}): CodexAppEnvironment {
  return {
    shape: 'local_chat',
    appVersion: '26.1.0',
    accountTier: 'plus',
    administratorPolicyScope: 'personal',
    census: census(),
    taskCreatedBy: 'user',
    toolExecution: 'hook_host',
    hookDeployment: 'local_config',
    hookRuns: ['PostToolUse', 'Stop'],
    mcpActive: true,
    ...overrides,
  };
}

/** A synthetic proof for one tuple, used only to exercise the gate. */
function proven(env: CodexAppEnvironment): CodexAppProvenCell[] {
  const identity = codexAppIdentity(env, env.shape!) as CodexAppProvenCell['identity'];
  return MODES.map(mode => ({ identity, mode, evidenceRef: 'trial.jsonl', evidenceRevision: 'rev-1' }));
}

const statuses = (env: CodexAppEnvironment, cells?: readonly CodexAppProvenCell[]) =>
  MODES.map(mode => inspectCodexApp(env, limits, cells).capabilities.modes[mode].status);

describe('Codex app proof record', () => {
  it('transcribes the committed record: no cell is proven, so no code-side cell exists', () => {
    const provenInRecord = proofRecord.cells.filter(cell => cell.status === 'proven');
    expect(provenInRecord).toEqual([]);
    expect(CODEX_APP_PROVEN_CELLS).toEqual([]);
    for (const cell of proofRecord.cells) {
      expect(CODEX_APP_BOUNDARIES[cell.mode as keyof typeof CODEX_APP_BOUNDARIES]).toBe(cell.boundary);
    }
    expect([...new Set(proofRecord.cells.map(cell => cell.shape))]).toEqual([...CODEX_APP_SHAPES]);
  });
});

describe('inspectCodexApp', () => {
  it('reports every mode unknown for both shapes today, even with an active route', () => {
    for (const shape of CODEX_APP_SHAPES) {
      const hookDeployment = shape === 'local_chat' ? 'local_config' : 'task_environment';
      const inspection = inspectCodexApp(environment({ shape, hookDeployment }), limits);
      expect(decodeAppHarnessRecord(inspection.record).ok).toBe(true);
      expect(decodeHarnessCapabilities(inspection.capabilities)).toEqual({ ok: true, value: inspection.capabilities });
      expect(inspection.capabilities).toMatchObject({
        support: 'unsupported', acknowledgement: 'unknown', existingSession: 'unknown', evidenceRef: CODEX_APP_PROOF_RECORD,
      });
      for (const mode of MODES) {
        expect(inspection.capabilities.modes[mode]).toMatchObject({ status: 'unknown', evidenceRef: null });
        expect(inspection.capabilities.modes[mode].reason).toMatch(/^Blocked: /);
      }
      expect(inspection.capabilities.modes.sync.reason).toContain('Idle agents receive messages only at their next turn.');
    }
  });

  it('claims a mode only for an exact proven tuple whose route ran in this session', () => {
    const env = environment();
    const inspection = inspectCodexApp(env, limits, proven(env));
    expect(decodeAppHarnessRecord(inspection.record).ok).toBe(true);
    expect(statuses(env, proven(env))).toEqual(['proven', 'proven', 'proven']);
    expect(inspection.capabilities).toMatchObject({
      support: 'tested', acknowledgement: 'batch_token_next_call', existingSession: 'native_hooks',
      reconcileByReleaseId: 'unsupported', immediateNotification: 'unknown',
    });
    const asyncOnly = inspectCodexApp(env, limits, proven(env).filter(cell => cell.mode === 'async')).capabilities;
    expect(asyncOnly).toMatchObject({ support: 'tested', existingSession: 'unknown' });
    expect(inspection.capabilities.modes.steer.reason).toContain('Hard abort is disabled');
  });

  it('keeps desktop and cloud evidence scopes distinct', () => {
    const cloud = environment({ shape: 'cloud_task', hookDeployment: 'task_environment' });
    expect(statuses(environment(), proven(cloud))).toEqual(['unknown', 'unknown', 'unknown']);
    expect(statuses(cloud, proven(environment()))).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('never widens a proof to another version, tier, or policy', () => {
    const cells = proven(environment());
    expect(statuses(environment({ appVersion: '26.1.1' }), cells)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(statuses(environment({ accountTier: 'team' }), cells)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(statuses(environment({ administratorPolicyScope: 'enterprise' }), cells)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('never matches a proof against an unobserved tuple field', () => {
    const env = environment({ accountTier: null });
    expect(statuses(env, proven(env))).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('fails steer closed when tools may run hosted and skip the hook', () => {
    const env = environment({ toolExecution: 'hosted' });
    expect(statuses(env, proven(env))).toEqual(['unknown', 'proven', 'proven']);
    expect(inspectCodexApp(env, limits, proven(env)).capabilities.modes.steer.reason).toContain('hosted');
    const unsure = environment({ toolExecution: 'unknown' });
    expect(statuses(unsure, proven(unsure))[0]).toBe('unknown');
  });

  it('does not treat a web plugin install as a local hook run', () => {
    const env = environment({ hookDeployment: 'web_plugin' });
    expect(statuses(env, proven(env))).toEqual(['unknown', 'unknown', 'proven']);
    const unrun = environment({ hookRuns: [] });
    expect(statuses(unrun, proven(unrun))).toEqual(['unknown', 'unknown', 'proven']);
  });

  it('claims nothing for a session the census cannot vouch for', () => {
    const cases: [CodexAppCensus | null, string][] = [
      [null, 'No process census'],
      [{ ...census(), sessionPid: 99 }, 'not in the process census'],
      [census(['codex'], ['node', '/usr/lib/node_modules/@aiur/khala/bin/khala.js']), 'under a Khala process'],
      [census(['codex', '--yolo']), '--yolo'],
      [census(['codex', '--dangerously-bypass-approvals-and-sandbox']), '--dangerously-bypass-approvals-and-sandbox'],
      [census(['codex', '-a', 'never']), '-a never'],
      [census(['codex', '--ask-for-approval=never']), '--ask-for-approval never'],
      [census(['codex', '-s', 'danger-full-access']), '-s danger-full-access'],
      [census(['codex', '-c', 'approval_policy=never']), '-c approval_policy=never'],
      [census(['codex', '-c', 'sandbox_mode="danger-full-access"']), 'sandbox_mode'],
    ];
    for (const [observed, reason] of cases) {
      const env = environment({ census: observed });
      expect(statuses(env, proven(env))).toEqual(['unknown', 'unknown', 'unknown']);
      for (const mode of MODES) {
        expect(inspectCodexApp(env, limits, proven(env)).capabilities.modes[mode].reason).toContain(reason);
      }
    }
  });

  it('checks the session tree, not unrelated Codex processes', () => {
    const base = census();
    const child = environment({
      census: { ...base, processes: [...base.processes, { pid: 50, ppid: 30, argv: ['codex', 'app-server', '--yolo'] }] },
    });
    expect(statuses(child, proven(child))).toEqual(['unknown', 'unknown', 'unknown']);
    const unrelated = environment({
      census: { ...base, processes: [...base.processes, { pid: 60, ppid: 1, argv: ['codex', '--yolo'] }] },
    });
    expect(statuses(unrelated, proven(unrelated))).toEqual(['proven', 'proven', 'proven']);
  });

  it('claims nothing for a cloud task the user did not create', () => {
    for (const taskCreatedBy of ['other', 'unknown'] as const) {
      const env = environment({ shape: 'cloud_task', hookDeployment: 'task_environment', taskCreatedBy });
      expect(statuses(env, proven(env))).toEqual(['unknown', 'unknown', 'unknown']);
    }
  });

  it('requires the MCP entry to be active for async', () => {
    const env = environment({ mcpActive: false });
    expect(statuses(env, proven(env))).toEqual(['proven', 'proven', 'unknown']);
  });

  it('returns no record for a surface the proof record does not cover', () => {
    const inspection = inspectCodexApp(environment({ shape: null }), limits);
    expect(inspection.record).toBeNull();
    expect(decodeHarnessCapabilities(inspection.capabilities).ok).toBe(true);
    expect(statuses(environment({ shape: null }))).toEqual(['unknown', 'unknown', 'unknown']);
  });
});
