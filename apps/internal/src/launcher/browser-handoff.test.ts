import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type EnvironmentProfile, OPENER_COMMAND, PROVEN_PROFILES, automaticOpenDecision, handoffDocument, leakForms, openBootstrap,
} from './browser-handoff';

const credential = `${'c'.repeat(42)}A`;
const bootstrapUrl = `http://127.0.0.1:4870/__khala/bootstrap#credential=${credential}&channel=ch_1`;
const proven: EnvironmentProfile = PROVEN_PROFILES[0]!.profile;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function parent(): string {
  const root = fs.mkdtempSync(path.join('/tmp', 'khala-handoff-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

type Call = Readonly<{ command: string; args: readonly string[]; env: Record<string, string> }>;

function recordingSpawn(result: 'spawn' | 'error' | 'throw' = 'spawn') {
  const calls: Call[] = [];
  const spawn = (command: string, args: readonly string[], options: Readonly<{ env: Record<string, string> }>) => {
    calls.push({ command, args: [...args], env: options.env });
    if (result === 'throw') throw Object.assign(new Error('boom'), { code: 'EACCES' });
    const child = Object.assign(new EventEmitter(), { unref() {} });
    queueMicrotask(() => result === 'spawn' ? child.emit('spawn') : child.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })));
    return child as unknown as ChildProcess;
  };
  return { calls, spawn };
}

describe('browser handoff', () => {
  it('stays off for unproven or incomplete profiles and spawns nothing', async () => {
    const { calls, spawn } = recordingSpawn();
    for (const capture of [
      () => null,
      () => ({ ...proven, browser: { name: 'chromium', major: '151' } }),
      () => ({ ...proven, opener: { ...proven.opener, display: 'absent' } }),
      () => ({ ...proven, handler: { mimeType: 'text/html' } }),
      () => { throw new Error('xdg-mime missing'); },
    ]) {
      const outcome = await openBootstrap({ bootstrapUrl, credential, handoffParent: parent(), env: {}, capture, spawn });
      expect(outcome.opened).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('passes a proven opener only the private file path, never the URL or credential', async () => {
    const handoffParent = parent();
    const { calls, spawn } = recordingSpawn();
    const outcome = await openBootstrap({
      bootstrapUrl, credential, handoffParent, env: { HOME: '/home/x', BROWSER: 'evil %s', XDG_CURRENT_DESKTOP: 'KDE' },
      capture: () => proven, spawn,
    });
    expect(outcome).toMatchObject({ opened: true, profileId: PROVEN_PROFILES[0]!.id });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.command).toBe(OPENER_COMMAND);
    expect(call!.args).toHaveLength(1);
    const file = call!.args[0]!;
    expect(path.isAbsolute(file) && file.startsWith(handoffParent)).toBe(true);
    expect(call!.env.BROWSER).toBeUndefined();
    expect(call!.env.XDG_CURRENT_DESKTOP).toBe('X-Generic');
    const serialized = JSON.stringify([call!.args, call!.env]);
    for (const form of leakForms(credential)) expect(serialized).not.toContain(form);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toContain(JSON.stringify(bootstrapUrl));
    if (outcome.opened) await outcome.cleanup();
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });

  it('refuses when the credential would reach the opener environment', async () => {
    const handoffParent = parent();
    const { calls, spawn } = recordingSpawn();
    const outcome = await openBootstrap({
      bootstrapUrl, credential, handoffParent, env: { LEAKED: bootstrapUrl }, capture: () => proven, spawn,
    });
    expect(outcome).toEqual({ opened: false, reason: 'credential would reach opener argv or environment' });
    expect(calls).toEqual([]);
    expect(fs.readdirSync(handoffParent)).toEqual([]);
  });

  it('turns a missing parent, spawn error, or throwing spawn into a normal not-opened result', async () => {
    const missing = await openBootstrap({
      bootstrapUrl, credential, handoffParent: path.join(parent(), 'missing'), env: {}, capture: () => proven, spawn: recordingSpawn().spawn,
    });
    expect(missing).toEqual({ opened: false, reason: 'private handoff file could not be prepared' });
    for (const mode of ['error', 'throw'] as const) {
      const handoffParent = parent();
      const outcome = await openBootstrap({ bootstrapUrl, credential, handoffParent, env: {}, capture: () => proven, spawn: recordingSpawn(mode).spawn });
      expect(outcome.opened).toBe(false);
      expect(fs.readdirSync(handoffParent)).toEqual([]);
    }
  });

  it('matches only on every proven field and escapes the URL in the redirect document', () => {
    expect(automaticOpenDecision(proven, PROVEN_PROFILES)).toEqual({ open: true, profileId: PROVEN_PROFILES[0]!.id });
    expect(automaticOpenDecision({ ...proven, procfsHidepid: 'invisible' }, PROVEN_PROFILES).open).toBe(false);
    expect(handoffDocument('http://127.0.0.1:1/#</script><script>x').toString('utf8')).not.toContain('</script><script>x');
  });
});
