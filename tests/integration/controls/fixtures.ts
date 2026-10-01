import { execFile } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';
import { readLiveHumanEnvironment } from '../human/fixtures';

const execute = promisify(execFile);

type ControlsConfig = Readonly<{
  roomId: string;
  bindingId: string;
  agentParticipantId: string;
  connectorControl: Readonly<{ executable: string; args: readonly string[];
    processExecutable: string; processCwd: string; processCgroup: string }>;
}>;
type ProcessWitness = Readonly<{ pid: number; bindingId: string; sessionId: string; generation: number;
  startTicks: string }>;

function fail(field: string): never { throw new Error(`Invalid live controls descriptor: ${field}`); }
function nonempty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(field);
  return value;
}

/** Reads only setup metadata. Human credentials remain in the existing OAuth fixture. */
export function readLiveControlsEnvironment() {
  const human = readLiveHumanEnvironment();
  const path = process.env.KHALA_E2E_DISPOSABLE_ENV;
  if (!path || !isAbsolute(path)) fail('KHALA_E2E_DISPOSABLE_ENV must be absolute');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { controls?: Partial<ControlsConfig> };
  const controls = raw.controls;
  if (!controls) fail('controls must identify a pre-paired disposable owner connector');
  const connector = controls.connectorControl;
  if (!connector || !isAbsolute(connector.executable)
    || !Array.isArray(connector.args) || !connector.args.every(value => typeof value === 'string')
    || !isAbsolute(connector.processExecutable) || !isAbsolute(connector.processCwd)
    || typeof connector.processCgroup !== 'string' || !connector.processCgroup.startsWith('/')) {
    fail('controls.connectorControl must name an absolute executable, string args, process executable/cwd and cgroup');
  }
  return { human, controls: {
    roomId: nonempty(controls.roomId, 'controls.roomId'),
    bindingId: nonempty(controls.bindingId, 'controls.bindingId'),
    agentParticipantId: nonempty(controls.agentParticipantId, 'controls.agentParticipantId'),
    connectorControl: { executable: connector.executable, args: connector.args,
      processExecutable: connector.processExecutable, processCwd: connector.processCwd,
      processCgroup: connector.processCgroup },
  } as ControlsConfig };
}

/** Operator-owned adapter must inspect/restart the real connector, never a test double. */
export async function connectorWitness(config: ControlsConfig, action: 'status' | 'restart'): Promise<ProcessWitness> {
  const { stdout } = await execute(config.connectorControl.executable,
    [...config.connectorControl.args, action], { timeout: 30_000, maxBuffer: 4096 });
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return fail(`connectorControl ${action} did not return JSON`); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(`connectorControl ${action} witness`);
  const witness = parsed as Partial<ProcessWitness>;
  if (!Number.isSafeInteger(witness.pid) || (witness.pid ?? 0) < 1
    || !Number.isSafeInteger(witness.generation) || (witness.generation ?? -1) < 0
    || witness.bindingId !== config.bindingId || typeof witness.sessionId !== 'string' || !witness.sessionId) {
    fail(`connectorControl ${action} must return current pid, bindingId, generation and sessionId`);
  }
  try { process.kill(witness.pid!, 0); }
  catch { fail(`connectorControl ${action} must identify a running local process`); }
  const pid = witness.pid!;
  const expected = config.connectorControl;
  let startTicks: string;
  try {
    if (readlinkSync(`/proc/${pid}/exe`) !== resolve(expected.processExecutable)
      || readlinkSync(`/proc/${pid}/cwd`) !== resolve(expected.processCwd)) fail(`connectorControl ${action} process identity`);
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    if (!cgroup.split('\n').some(line => line.split(':').slice(2).join(':') === expected.processCgroup)) {
      fail(`connectorControl ${action} process cgroup`);
    }
    // /proc stat field 22 is process start time; the command name may contain spaces.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    startTicks = fields[19] ?? fail(`connectorControl ${action} process start time`);
  } catch { return fail(`connectorControl ${action} process identity unavailable`); }
  return { ...witness, startTicks } as ProcessWitness;
}

/** PID reuse is harmless: compare the kernel's process start tick too. */
export function sameProcessRunning(witness: ProcessWitness): boolean {
  try {
    const stat = readFileSync(`/proc/${witness.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    return fields[19] === witness.startTicks && fields[0] !== 'Z';
  } catch { return false; }
}

type MailboxAnswer = Readonly<{ status: number; body: unknown }>;
/** Uses the browser's actual session cookie and /me CSRF value, never injected authority. */
export async function mailbox(page: Page, bindingId: string, kind: 'controls_status' | 'controls_set' | 'listening_set', body: unknown,
  operationId = `controls_${crypto.randomUUID().replaceAll('-', '')}`): Promise<MailboxAnswer & { operationId: string }> {
  return page.evaluate(async ({ bindingId, kind, body, operationId }) => {
    const meResponse = await fetch('/api/human/me', { credentials: 'same-origin' });
    const me = await meResponse.json() as { csrfToken?: unknown };
    if (meResponse.status !== 200 || typeof me.csrfToken !== 'string') {
      return { status: meResponse.status, body: { code: 'owner_session_unavailable' }, operationId };
    }
    const response = await fetch('/api/human/owner-mailbox/submit', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-khala-csrf': me.csrfToken },
      body: JSON.stringify({ bindingId, kind, body, operationId }),
    });
    return { status: response.status, body: await response.json() as unknown, operationId };
  }, { bindingId, kind, body, operationId });
}

export async function mailboxOutcome(page: Page, bindingId: string, operationId: string): Promise<unknown> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    const answer = await page.evaluate(async ({ bindingId, operationId }) => {
      const url = new URL('/api/human/owner-mailbox/result', location.origin);
      url.searchParams.set('binding_id', bindingId);
      url.searchParams.set('operation_id', operationId);
      const response = await fetch(url, { credentials: 'same-origin' });
      return { status: response.status, body: await response.json() as unknown };
    }, { bindingId, operationId });
    if (answer.status !== 200) fail(`mailbox result HTTP ${answer.status}`);
    last = answer.body;
    if (typeof last === 'object' && last !== null && 'outcome' in last && last.outcome !== null) return last.outcome;
    await page.waitForTimeout(200);
  }
  return fail(`mailbox ${operationId} never completed`);
}

export async function controlsStatus(page: Page, bindingId: string) {
  const submitted = await mailbox(page, bindingId, 'controls_status', { bindingId });
  if (submitted.status !== 200) fail(`controls status HTTP ${submitted.status}`);
  const outcome = await mailboxOutcome(page, bindingId, submitted.operationId);
  if (typeof outcome !== 'object' || outcome === null || !('ok' in outcome) || outcome.ok !== true
    || !('status' in outcome)) fail('controls status was not acknowledged by connector');
  return outcome.status as {
    binding: { bindingId: string; generation: number; agentParticipantId: string; sessionId: string };
    policy: { effectiveVersion: number | null; effectiveMode: string | null; paused: boolean | null };
    bindingStatus: string;
    listening: { bindingId: string; generation: number; version: number;
      requested: 'steer' | 'sync' | 'async' | null; effective: 'steer' | 'sync' | 'async' | null;
      support: Record<'steer' | 'sync' | 'async', { status: string; reason: string | null }>;
      lastChangedBy: { kind: string } };
  };
}
