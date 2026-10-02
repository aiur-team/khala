import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Actor, NativeFact } from './external-witness.js';

export type NativeSession = Readonly<{
  actor: Actor;
  sessionId: string;
  sessionFingerprint?: string;
  pid: number;
  processStartTicks: string;
  cliVersion: string;
  candidate?: Readonly<{ candidateId: string; operationId: string }>;
  discoveryConsentUrl?: string;
  bindingId?: string;
  generation?: number;
  agentParticipantId?: string;
}>;
export type NativeSnapshot = Readonly<{
  sessions: readonly NativeSession[];
  native?: readonly NativeFact[];
  peer?: Readonly<{ from: Actor; to: Actor; eventId: string; readEventId: string; replyEventId: string }>;
}>;
export type ObservedExchange = Readonly<{
  actor: Actor; sessionId: string; bindingId: string; generation: number;
  operationId: string; challengeEventId: string; releaseId: string; replyEventId: string;
}>;
export type ObservedPeer = Readonly<{
  from: Actor; to: Actor; eventId: string; readEventId: string; replyEventId: string;
}>;

const identifier = /^[A-Za-z0-9_$.:/+!=~-]{4,256}$/u;
const version = /^[A-Za-z0-9._+ ()-]{3,80}$/u;

/** The fresh disposable owner inbox has exactly one pending access request per actor. */
export function exactOwnerAccessRequest(body: unknown, actor: Actor): Readonly<{ fingerprint: string; title: string }> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('external_browser_owner_inbox_invalid');
  const payload = body as Record<string, unknown>;
  if (payload.v !== 1 || payload.kind !== 'ok' || !Array.isArray(payload.requests))
    throw new Error('external_browser_owner_inbox_invalid');
  const pending = payload.requests.filter(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    const detail = row.detail as Record<string, unknown> | undefined;
    return row.operationKind === 'access' && row.ownerDecision === 'pending' && detail?.kind === 'access';
  }) as Array<Record<string, unknown>>;
  if (pending.length > 1) throw new Error('external_browser_owner_request_ambiguous');
  if (pending.length === 0) return null;
  const row = pending[0]!;
  const requester = row.requester as Record<string, unknown> | undefined;
  const detail = row.detail as Record<string, unknown> | undefined;
  if (requester?.harness !== actor || typeof detail?.title !== 'string' || detail.title.length === 0)
    throw new Error('external_browser_owner_request_identity_mismatch');
  const fingerprint = requester.sessionFingerprint;
  if (typeof fingerprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(fingerprint))
    throw new Error('external_browser_owner_fingerprint_invalid');
  return { fingerprint, title: detail.title };
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error(`external_browser_${name}_invalid`);
  return value;
}

function session(value: unknown, actor: Actor): NativeSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`external_browser_${actor}_missing`);
  const row = value as Record<string, unknown>;
  if (row.actor !== actor) throw new Error(`external_browser_${actor}_actor_mismatch`);
  const pid = row.pid;
  if (!Number.isSafeInteger(pid) || Number(pid) < 1) throw new Error(`external_browser_${actor}_pid_invalid`);
  const result: NativeSession = {
    actor, sessionId: requireIdentifier(row.sessionId, 'session_id'),
    pid: Number(pid), processStartTicks: requireIdentifier(row.processStartTicks, 'start_ticks'),
    cliVersion: typeof row.cliVersion === 'string' && version.test(row.cliVersion)
      ? row.cliVersion : requireIdentifier(row.cliVersion, 'cli_version'),
    ...(row.sessionFingerprint === undefined ? {} : { sessionFingerprint: requireIdentifier(row.sessionFingerprint, 'session_fingerprint') }),
    ...(row.candidate === undefined ? {} : { candidate: (() => {
      if (!row.candidate || typeof row.candidate !== 'object' || Array.isArray(row.candidate))
        throw new Error(`external_browser_${actor}_candidate_invalid`);
      const candidate = row.candidate as Record<string, unknown>;
      const candidateId = requireIdentifier(candidate.candidateId, 'candidate_id');
      if (!/^[A-Za-z0-9_-]{43}$/u.test(candidateId)) throw new Error(`external_browser_${actor}_candidate_invalid`);
      return { candidateId, operationId: requireIdentifier(candidate.operationId, 'candidate_operation_id') };
    })() }),
    ...(row.discoveryConsentUrl === undefined ? {} : { discoveryConsentUrl: (() => {
      if (typeof row.discoveryConsentUrl !== 'string') throw new Error(`external_browser_${actor}_discovery_url_invalid`);
      let url: URL;
      try { url = new URL(row.discoveryConsentUrl); } catch { throw new Error(`external_browser_${actor}_discovery_url_invalid`); }
      if (url.protocol !== 'https:' || url.pathname !== '/api/human/channel-discovery/bootstrap/authorize')
        throw new Error(`external_browser_${actor}_discovery_url_invalid`);
      return url.href;
    })() }),
    ...(row.bindingId === undefined ? {} : { bindingId: requireIdentifier(row.bindingId, 'binding_id') }),
    ...(row.generation === undefined ? {} : { generation: Number(row.generation) }),
    ...(row.agentParticipantId === undefined ? {} : { agentParticipantId: requireIdentifier(row.agentParticipantId, 'agent_participant_id') }),
  };
  if (result.generation !== undefined && (!Number.isSafeInteger(result.generation) || result.generation < 0))
    throw new Error(`external_browser_${actor}_generation_invalid`);
  return result;
}

/** Bind every native claim to owner/browser observations before the witness oracle sees it. */
export function assertWitnessMatches(snapshot: NativeSnapshot, observed: readonly ObservedExchange[], peer: ObservedPeer): void {
  if (observed.length !== 2 || snapshot.native?.length !== 2 || !snapshot.peer)
    throw new Error('external_browser_witness_missing');
  for (const expected of observed) {
    const fact = snapshot.native.find(row => row.actor === expected.actor);
    const session = snapshot.sessions.find(row => row.actor === expected.actor);
    if (!fact || !session || fact.sessionId !== expected.sessionId || session.sessionId !== expected.sessionId
      || fact.bindingId !== expected.bindingId || session.bindingId !== expected.bindingId
      || fact.generation !== expected.generation || session.generation !== expected.generation
      || fact.operationId !== expected.operationId || fact.challengeEventId !== expected.challengeEventId
      || fact.releaseId !== expected.releaseId || fact.replyEventId !== expected.replyEventId)
      throw new Error(`external_browser_${expected.actor}_witness_identity_mismatch`);
  }
  if (snapshot.peer.from !== peer.from || snapshot.peer.to !== peer.to || snapshot.peer.eventId !== peer.eventId
    || snapshot.peer.readEventId !== peer.readEventId || snapshot.peer.replyEventId !== peer.replyEventId)
    throw new Error('external_browser_peer_witness_identity_mismatch');
}

/** All private observations stay in the disposable topology's private directory. */
export function decodeNativeSnapshot(parsed: unknown): NativeSnapshot {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('external_browser_native_snapshot_invalid');
  const row = parsed as Record<string, unknown>;
  const rawSessions = row.sessions;
  if (!Array.isArray(rawSessions) || rawSessions.length !== 2) throw new Error('external_browser_two_sessions_required');
  const sessions = (['codex', 'claude'] as const).map(actor => session(rawSessions.find(value =>
    typeof value === 'object' && value !== null && (value as Record<string, unknown>).actor === actor), actor));
  if (sessions[0].sessionId === sessions[1].sessionId || (sessions[0].sessionFingerprint
    && sessions[0].sessionFingerprint === sessions[1].sessionFingerprint))
    throw new Error('external_browser_distinct_sessions_required');
  return { sessions, ...(Array.isArray(row.native) ? { native: row.native as NativeFact[] } : {}),
    ...(row.peer && typeof row.peer === 'object' ? { peer: row.peer as NativeSnapshot['peer'] } : {}) };
}

export class ExternalNativeDriver {
  constructor(readonly directory: string, readonly script: string) {
    if (!isAbsolute(directory) || !isAbsolute(script)) throw new Error('external_browser_private_paths_required');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private call(action: string, ...args: string[]): void {
    execFileSync(process.execPath, [this.script, action, this.directory, ...args], {
      env: process.env, stdio: 'pipe', timeout: action === 'prompt' ? 150_000 : 90_000,
    });
  }

  launch(): void { this.call('launch'); }
  stop(): void { if (existsSync(join(this.directory, 'native-sessions.json'))) this.call('stop'); }
  service(): void { this.call('service'); }
  clearDiscovery(actor: Actor): void { this.call('clear-open', actor); }
  mark(): void { this.call('mark'); }

  prompt(actor: Actor, instruction: string): void {
    const file = join(this.directory, `prompt-${actor}-${randomUUID()}.txt`);
    writeFileSync(file, instruction, { flag: 'wx', mode: 0o600 });
    try { this.call('prompt', actor, file); }
    finally { unlinkSync(file); }
  }

  witness(input: unknown): NativeSnapshot {
    const file = join(this.directory, `witness-${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify(input), { flag: 'wx', mode: 0o600 });
    try { this.call('witness', file); }
    finally { unlinkSync(file); }
    return this.inspect();
  }

  inspect(): NativeSnapshot {
    this.call('inspect');
    const parsed = JSON.parse(readFileSync(join(this.directory, 'native-sessions.json'), 'utf8')) as unknown;
    return decodeNativeSnapshot(parsed);
  }
}

export async function encryptedEventIds(page: Page, body: string): Promise<string> {
  const row = page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: body });
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  const eventId = await row.getAttribute('data-event-id');
  return requireIdentifier(eventId, 'event_id');
}
