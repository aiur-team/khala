// The local server, started through `internal-launcher` exactly as a user starts
// it (`npx @aiur/khala internal`), and driven as the human through the owner's
// loopback routes. The runner's own launcher process is the only process it
// starts and the only one it closes; agent CLIs are never touched.

import { spawn } from 'node:child_process';
import { assertCommand } from '../guard';
import type {
  AccessRequest, LaunchedServer, LauncherPort, ModeRequest, OwnerSession, StopReply, StopTarget, TimelineEvent,
} from '../types';

export type LaunchReport = Readonly<{ channelId: string; origin: string; url: string }>;

const REPORT_TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 100;

type Reply = Readonly<{ status: number; json: unknown }>;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stopTarget(value: unknown): StopTarget {
  const entry = record(value);
  return { bindingId: text(entry.bindingId), generation: Number(entry.generation), agentParticipantId: text(entry.agentParticipantId) };
}

/** Redeems the launcher's bootstrap link the way the browser bootstrap does, and acts as the human. */
export async function ownerSessionFor(report: LaunchReport): Promise<OwnerSession> {
  const { origin, channelId } = report;
  const fragment = new URLSearchParams(new URL(report.url).hash.slice(1));
  const bootstrap = await fetch(`${origin}/__khala/session`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ credential: fragment.get('credential'), channelId: fragment.get('channel') }),
  });
  if (bootstrap.status !== 200) throw new Error(`owner session bootstrap failed: ${bootstrap.status}`);
  const cookie = bootstrap.headers.getSetCookie()[0]!.split(';')[0]!;
  const { requestSecret } = await bootstrap.json() as { requestSecret: string };

  async function call(pathname: string, init: Readonly<{ method?: string; body?: unknown }> = {}): Promise<Reply> {
    const response = await fetch(`${origin}${pathname}`, {
      method: init.method ?? 'GET',
      headers: {
        cookie, origin, 'x-khala-request-secret': requestSecret,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const body = await response.text();
    let json: unknown = null;
    try { json = JSON.parse(body); } catch { /* not JSON */ }
    return { status: response.status, json };
  }

  return {
    channelId,
    channelUrl: `${origin}/channels/${channelId}`,
    async timeline() {
      const events: TimelineEvent[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) });
        const reply = await call(`/api/v1/channels/${channelId}/timeline?${query}`);
        if (reply.status !== 200) throw new Error(`timeline read failed: ${reply.status}`);
        const page = record(reply.json);
        for (const value of Array.isArray(page.events) ? page.events : []) {
          const event = record(value);
          const participant = record(event.participant);
          events.push({
            eventId: text(event.eventId),
            authorParticipantId: text(participant.participantId),
            authorKind: text(participant.kind),
            body: text(record(event.content).body),
            receivedAt: text(event.receivedAt),
          });
        }
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null;
      } while (cursor);
      return events;
    },
    async say(body, clientTxnId) {
      const reply = await call(`/api/v1/channels/${channelId}/messages`, {
        method: 'POST', body: { clientTxnId, content: { v: 1, kind: 'text', body } },
      });
      if (reply.status !== 201 && reply.status !== 200) throw new Error(`owner message refused: ${reply.status}`);
      return text(record(record(reply.json).event).eventId);
    },
    async accessRequests() {
      const reply = await call('/api/human/channel-requests');
      if (reply.status !== 200) throw new Error(`channel request inbox failed: ${reply.status}`);
      const requests = record(reply.json).requests;
      return (Array.isArray(requests) ? requests : [])
        .map(record)
        .filter(request => request.operationKind === 'access')
        .map((request): AccessRequest => ({
          requestHandle: text(request.requestHandle),
          revision: text(request.revision),
          outcome: text(request.outcome),
          harness: text(record(request.requester).harness),
          sessionFingerprint: text(record(request.requester).sessionFingerprint),
        }));
    },
    async approve(request, operationId) {
      const reply = await call(`/api/human/channel-access-requests/${request.requestHandle}/decision`, {
        method: 'POST',
        body: { v: 1, requestHandle: request.requestHandle, expectedRevision: request.revision, decision: 'approve', operationId },
      });
      if (reply.status !== 200) throw new Error(`grant refused: ${reply.status}`);
    },
    async requestMode(): Promise<ModeRequest> {
      // The internal server composes no listening-mode control yet, so no mode can be
      // confirmed effective. Report it honestly instead of assuming the server default.
      return { kind: 'unsupported', reason: 'internal mode serves no listening-mode control (#392)' };
    },
    async stop(targets): Promise<StopReply> {
      const reply = await call(`/api/v1/channels/${channelId}/stop`, { method: 'POST', body: { v: 1, targets } });
      const body = record(reply.json);
      if (reply.status !== 200) return { kind: 'refused', status: reply.status, code: text(record(body.error).code) || 'refused' };
      const stopped = (Array.isArray(body.stopped) ? body.stopped : []).map(stopTarget);
      const remaining = (Array.isArray(body.remaining) ? body.remaining : []).map(stopTarget);
      if (body.outcome === 'stopped' && remaining.length === 0) return { kind: 'stopped', stopped };
      if (body.outcome === 'partial') return { kind: 'partial', stopped, remaining };
      return { kind: 'refused', status: reply.status, code: 'unrecognized_reply' };
    },
    async viewable() {
      const api = await call(`/api/v1/channels/${channelId}`);
      const page = await fetch(`${origin}/channels/${channelId}`);
      await page.body?.cancel();
      return api.status === 200 && page.status === 200;
    },
  };
}

export async function reachable(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/** `npx --yes <staged package spec> internal [--resume <channel-id>]`, running until closed. */
export function npxLauncher(env: NodeJS.ProcessEnv = process.env): LauncherPort {
  return {
    async start(khalaPackage, resume) {
      const argv = ['npx', '--yes', khalaPackage, 'internal', ...(resume === null ? [] : ['--resume', resume])];
      assertCommand(argv, khalaPackage);
      const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ['ignore', 'pipe', 'inherit'] });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
      const deadline = Date.now() + REPORT_TIMEOUT_MS;
      while (!stdout.includes('\n')) {
        if (child.exitCode !== null) throw new Error(`launcher exited ${child.exitCode} before reporting`);
        if (Date.now() > deadline) { child.kill('SIGINT'); throw new Error('launcher did not report'); }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const report = JSON.parse(stdout.split('\n')[0]!) as LaunchReport & { ok?: boolean; kind?: string };
      if (report.ok !== true || report.kind !== 'running') throw new Error('launcher did not start');
      let closing: Promise<void> | null = null;
      const server: LaunchedServer = {
        channelId: report.channelId,
        origin: report.origin,
        humanUrl: report.url,
        owner: () => ownerSessionFor(report),
        close() {
          // Ctrl+C for the runner's own launcher; the server stops with it.
          closing ??= (child.exitCode === null && child.kill('SIGINT'), exited.then(() => undefined));
          return closing;
        },
        reachable: () => reachable(report.origin),
      };
      return server;
    },
  };
}
