import { readFileSync } from 'node:fs';
import { decodeHarnessCapabilities } from '@khala/contracts/delivery/index';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_RECEIPT_EVIDENCE } from './capabilities';
import { type FakeHarness, binding, deadlines, fakeHarness, limits, never } from './fakes';

const setup = fakeHarness;

afterEach(() => vi.useRealTimers());

describe('inspect', () => {
  it('claims the KHA-104 route for a Khala-hosted, loaded thread on the tested version', async () => {
    const { harness, server } = setup();
    const capabilities = await harness.inspect(binding());
    expect(decodeHarnessCapabilities(capabilities)).toEqual({ ok: true, value: capabilities });
    expect(capabilities).toEqual({
      v: 3, harness: 'codex', version: '0.154.0', adapterVersion: 'khala-hosted-queue-1', support: 'tested',
      existingSession: 'khala_hosted_resume', immediateNotification: 'khala_hosted_idle', busy: 'queue',
      receiptEvidence: ['transport_written', 'harness_queued', 'context_consumed', 'completed', 'outcome_unknown', 'failed'],
      reconcileByReleaseId: 'while_queued', limits, evidenceRef: 'docs/evidence/codex.md',
      modes: {
        steer: {
          status: 'unknown', route: 'codex-interactive-hooks-steer', testedVersion: '0.154.0',
          evidenceRef: null, evidenceRevision: null,
          reason: 'Khala-hosted app-server evidence is secondary and cannot prove delivery into the user-owned Codex TUI.',
        },
        sync: {
          status: 'unknown', route: 'codex-interactive-hooks-sync', testedVersion: '0.154.0',
          evidenceRef: null, evidenceRevision: null,
          reason: 'Khala-hosted app-server evidence is secondary and cannot prove delivery into the user-owned Codex TUI.',
        },
        async: {
          status: 'unknown', route: 'codex-interactive-hooks-async', testedVersion: '0.154.0',
          evidenceRef: null, evidenceRevision: null,
          reason: 'Khala-hosted app-server evidence is secondary and cannot prove delivery into the user-owned Codex TUI.',
        },
      },
      acknowledgement: 'unknown',
    });
    expect(Object.values(capabilities.modes).every(mode => mode.status === 'unknown')).toBe(true);
    // Metadata-only read; the probe never resumes, starts or queues anything.
    expect(server.calls).toEqual([{ method: 'thread/read', params: { threadId: 'session-b', includeTurns: false } }]);
    expect(server.closed).toBe(server.opened);
  });

  it('reports a busy thread on the route too: delivery queues behind the running turn', async () => {
    const { harness, server } = setup();
    server.status = 'active';
    expect((await harness.inspect(binding())).support).toBe('tested');
  });

  const unsupported = {
    support: 'unsupported', existingSession: 'unknown', immediateNotification: 'unknown', busy: 'unknown',
    reconcileByReleaseId: 'unknown', receiptEvidence: [],
  };

  it.each<[string, () => FakeHarness]>([
    ['absent session (no Khala host)', () => { const s = setup(); s.hosts.host = null; return s; }],
    ['stale binding generation', () => setup({ binding: binding({ generation: 1 }) })],
    ['host for another binding', () => setup({ binding: binding({ bindingId: 'bind-other' }) })],
    ['unsupported version, even a newer one', () => setup({ cliVersion: '0.155.0' })],
    ['writer lock held by another executor', () => setup({ holdsWriter: false })],
    ['endpoint in a shared directory', () => setup({ endpointPrivate: false })],
    ['relative socket path', () => setup({ endpoint: { kind: 'unix', path: 'exec.sock' } })],
    ['native cwd differs from the host workdir', () => { const s = setup(); s.server.cwd = '/home/owner/project'; return s; }],
    ['host workdir not absolute', () => { const s = setup({ workdir: 'scratch' }); s.server.cwd = 'scratch'; return s; }],
    ['host workdir not normalized', () => { const s = setup({ workdir: '/scratch/../scratch' }); s.server.cwd = '/scratch/../scratch'; return s; }],
    ['listener unreachable (executor exited)', () => { const s = setup(); s.server.reachable = false; return s; }],
    ['thread not loaded in the host', () => { const s = setup(); s.server.status = 'notLoaded'; return s; }],
    ['thread in system error', () => { const s = setup(); s.server.status = 'systemError'; return s; }],
    ['native thread id differs', () => {
      const s = setup();
      s.server.override('thread/read', () => ({ status: 'response', result: { thread: { id: 'other', cwd: '/scratch', status: { type: 'idle' } } } }));
      return s;
    }],
    ['native thread without a cwd', () => {
      const s = setup();
      s.server.override('thread/read', () => ({ status: 'response', result: { thread: { id: 'session-b', status: { type: 'idle' } } } }));
      return s;
    }],
    ['malformed native response', () => {
      const s = setup();
      s.server.override('thread/read', () => ({ status: 'response', result: { thread: { id: 'session-b' } } }));
      return s;
    }],
  ])('claims nothing for %s', async (_name, make) => {
    const { harness, server } = make();
    const capabilities = await harness.inspect(binding());
    expect(capabilities).toMatchObject(unsupported);
    expect(decodeHarnessCapabilities(capabilities).ok).toBe(true);
    expect(server.adds()).toBe(0);
    expect(server.closed).toBe(server.opened);
  });

  it('claims nothing for a binding of another harness without contacting any host', async () => {
    const { harness, server } = setup();
    expect(await harness.inspect(binding({ harness: 'claude' }))).toMatchObject(unsupported);
    expect(server.endpoints).toEqual([]);
  });

  it('claims nothing after close, without contacting any host', async () => {
    const { harness, server } = setup();
    await harness.close();
    expect(await harness.inspect(binding())).toMatchObject(unsupported);
    expect(server.endpoints).toEqual([]);
  });

  it('a synchronous throw from connect reports unreachable instead of rejecting', async () => {
    const { harness, server } = setup();
    server.connect = () => { throw new Error('socket exploded'); };
    await expect(harness.inspect(binding())).resolves.toMatchObject(unsupported);
    expect(server.closed).toBe(server.opened);
  });

  it.each<[string, (s: FakeHarness) => void]>([
    ['host lookup', s => { s.hosts.lookup = never; }],
    ['connect', s => { s.server.connect = never; }],
    ['thread/read', s => { s.server.override('thread/read', never); }],
  ])('a hung %s is bounded by the call deadline', async (_name, arrange) => {
    vi.useFakeTimers();
    const s = setup();
    arrange(s);
    const inspected = s.harness.inspect(binding());
    await vi.advanceTimersByTimeAsync(deadlines.callMs);
    expect(await inspected).toMatchObject(unsupported);
    expect(s.server.closed).toBe(s.server.opened);
  });
});

describe('receipt evidence', () => {
  // The KHA-106 contract fixture records what the KHA-104 proof observed natively.
  const fixture = JSON.parse(readFileSync(
    new URL('../../../contracts/fixtures/delivery/exact-release.json', import.meta.url), 'utf8',
  )) as { capabilities: { harness: string; version: string; receiptEvidence: string[] } };

  it('matches the contract fixture plus the connector-observed write', () => {
    expect(fixture.capabilities).toMatchObject({ harness: 'codex', version: '0.154.0' });
    expect(CODEX_RECEIPT_EVIDENCE.filter(kind => kind !== 'transport_written'))
      .toEqual(fixture.capabilities.receiptEvidence);
    expect(CODEX_RECEIPT_EVIDENCE).toContain('transport_written');
  });
});
