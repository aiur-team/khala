import { decodeHarnessCapabilities } from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import { FakeAppServer, FakeCodec, FakeHosts, RecordingSink, binding, clock, limits } from './fakes';
import { createCodexHarness } from './index';

function setup(hostOverrides: ConstructorParameters<typeof FakeHosts>[0] = {}) {
  const server = new FakeAppServer();
  const hosts = new FakeHosts(hostOverrides);
  const harness = createCodexHarness({
    client: server, hosts, codec: new FakeCodec(), clock, evidence: new RecordingSink(), limits,
  });
  return { server, hosts, harness };
}

describe('inspect', () => {
  it('claims the KHA-104 route for a Khala-hosted, loaded thread on the tested version', async () => {
    const { harness, server } = setup();
    const capabilities = await harness.inspect(binding());
    expect(decodeHarnessCapabilities(capabilities)).toEqual({ ok: true, value: capabilities });
    expect(capabilities).toMatchObject({
      harness: 'codex', version: '0.154.0', support: 'tested', existingSession: 'khala_hosted_resume',
      immediateNotification: 'khala_hosted_idle', busy: 'queue', reconcileByReleaseId: 'while_queued', limits,
      evidenceRef: 'docs/evidence/codex.md',
    });
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

  it.each([
    ['absent session (no Khala host)', () => { const s = setup(); s.hosts.host = null; return s; }],
    ['stale binding generation', () => setup({ binding: binding({ generation: 1 }) })],
    ['host for another binding', () => setup({ binding: binding({ bindingId: 'bind-other' }) })],
    ['unsupported version, even a newer one', () => setup({ cliVersion: '0.155.0' })],
    ['writer lock held by another executor', () => setup({ holdsWriter: false })],
    ['endpoint in a shared directory', () => setup({ endpointPrivate: false })],
    ['relative socket path', () => setup({ endpoint: { kind: 'unix', path: 'exec.sock' } })],
    ['listener unreachable (executor exited)', () => { const s = setup(); s.server.reachable = false; return s; }],
    ['thread not loaded in the host', () => { const s = setup(); s.server.status = 'notLoaded'; return s; }],
    ['thread in system error', () => { const s = setup(); s.server.status = 'systemError'; return s; }],
    ['native thread id differs', () => {
      const s = setup();
      s.server.override('thread/read', () => ({ status: 'response', result: { thread: { id: 'other', status: { type: 'idle' }, turns: [] } } }));
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
});
