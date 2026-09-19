import { describe, expect, it } from 'vitest';
import {
  binding, clock, deadlines, FakeAppServer, FakeCodec, FakeHosts, job, limits, never, payload, RecordingSink,
} from './fakes';
import { createCodexHarness } from './index';
import type {
  CodexNativeCliInspection, CodexNativeCliOutcome, CodexNativeCliPort, CodexNativeInboxDelivery,
  CodexNativeInboxPort,
} from './native-cli';

class FakeNativeCli implements CodexNativeCliPort {
  inspection: CodexNativeCliInspection = {
    version: '0.154.0', session: 'present', bindingId: 'bind-b-1', generation: 0,
    platform: 'linux', arch: 'x64',
  };
  outcome: CodexNativeCliOutcome | Promise<CodexNativeCliOutcome> = { status: 'queued', queueId: 'queue-native-1' };
  readonly inspected: string[] = [];
  readonly argv: string[][] = [];

  async inspect(sessionId: string) {
    this.inspected.push(sessionId);
    return this.inspection;
  }

  async run(argv: readonly string[]) {
    this.argv.push([...argv]);
    return this.outcome;
  }
}

class FakeInbox implements CodexNativeInboxPort {
  result: 'appended' | 'duplicate' = 'appended';
  readonly deliveries: CodexNativeInboxDelivery[] = [];

  async enqueue(delivery: CodexNativeInboxDelivery) {
    this.deliveries.push(delivery);
    return this.result;
  }
}

function nativeHarness() {
  const cli = new FakeNativeCli();
  const inbox = new FakeInbox();
  const server = new FakeAppServer();
  const hosts = new FakeHosts();
  hosts.host = null;
  const harness = createCodexHarness({
    client: server,
    hosts,
    codec: new FakeCodec(),
    clock,
    evidence: new RecordingSink(),
    limits,
    deadlines,
    nativeCli: cli,
    nativeInbox: inbox,
  });
  return { cli, inbox, server, hosts, harness };
}

describe('Codex native CLI route selection', () => {
  it('selects the native notification route once when no Khala host owns the thread', async () => {
    const { harness, cli } = nativeHarness();

    await expect(harness.inspect(binding())).resolves.toMatchObject({
      support: 'tested',
      existingSession: 'native_cli_queue',
      immediateNotification: 'native_cli_queue',
      reconcileByReleaseId: 'unsupported',
      evidenceRef: 'docs/evidence/codex-native-cli.md#queue-idle',
    });
    expect(cli.inspected).toEqual(['session-b']);
  });

  it.each([
    ['the registered host is unreachable', (selected: ReturnType<typeof nativeHarness>) => {
      selected.hosts.host = new FakeHosts().host;
      selected.server.reachable = false;
    }],
    ['the registered host does not hold the writer', (selected: ReturnType<typeof nativeHarness>) => {
      selected.hosts.host = new FakeHosts({ holdsWriter: false }).host;
    }],
  ])('does not fall back to native inspection when %s', async (_name, arrange) => {
    const selected = nativeHarness();
    arrange(selected);

    await expect(selected.harness.inspect(binding())).resolves.toMatchObject({ support: 'unsupported' });
    expect(selected.cli.inspected).toEqual([]);
  });

  it('caches capabilities for an immutable binding and replaces them for a new generation', async () => {
    const selected = nativeHarness();
    const original = binding();

    const first = await selected.harness.inspect(original);
    selected.hosts.host = new FakeHosts().host;
    const repeated = await selected.harness.inspect(binding());

    expect(repeated).toBe(first);
    expect(repeated).toMatchObject({ existingSession: 'native_cli_queue' });
    expect(selected.cli.inspected).toEqual(['session-b']);
    expect(selected.server.endpoints).toEqual([]);

    selected.cli.inspection = {
      version: '0.155.0', session: 'present', bindingId: 'bind-b-1', generation: 1,
      platform: 'linux', arch: 'x64',
    };
    selected.hosts.host = null;
    const replacement = await selected.harness.inspect(binding({ generation: 1 }));

    expect(replacement).not.toBe(first);
    expect(replacement).toMatchObject({ support: 'unsupported', version: '0.155.0' });
    expect(selected.cli.inspected).toEqual(['session-b', 'session-b']);
  });

  it('re-probes an unsupported result and can select a route after the native session appears', async () => {
    const selected = nativeHarness();
    selected.cli.inspection = { ...selected.cli.inspection, session: 'absent' };

    await expect(selected.harness.inspect(binding())).resolves.toMatchObject({ support: 'unsupported' });

    selected.cli.inspection = { ...selected.cli.inspection, session: 'present' };
    await expect(selected.harness.inspect(binding())).resolves.toMatchObject({
      support: 'tested', existingSession: 'native_cli_queue',
    });
    expect(selected.cli.inspected).toEqual(['session-b', 'session-b']);
  });

  it('keeps a Khala-hosted executor on route B even when the native CLI can see it', async () => {
    const selected = nativeHarness();
    selected.hosts.host = new FakeHosts().host;

    await expect(selected.harness.inspect(binding())).resolves.toMatchObject({
      existingSession: 'khala_hosted_resume',
      immediateNotification: 'khala_hosted_idle',
      reconcileByReleaseId: 'while_queued',
    });
    await expect(selected.harness.submit({ job: job(), payload: payload() })).resolves.toMatchObject({ kind: 'harness_queued' });
    expect(selected.server.adds()).toBe(1);
    expect(selected.inbox.deliveries).toEqual([]);
    expect(selected.cli.argv).toEqual([]);
  });

  it('rejects a native session whose listener holds a different inbox binding', async () => {
    const selected = nativeHarness();
    selected.cli.inspection = { ...selected.cli.inspection, bindingId: 'bind-other' };

    await expect(selected.harness.inspect(binding())).resolves.toMatchObject({ support: 'unsupported' });
    await expect(selected.harness.submit({ job: job(), payload: payload() })).resolves.toMatchObject({
      kind: 'failed', errorCode: 'harness_unavailable',
    });
    expect(selected.inbox.deliveries).toEqual([]);
    expect(selected.cli.argv).toEqual([]);
  });

  it('refuses an untested native CLI version without falling through during submit', async () => {
    const selected = nativeHarness();
    selected.cli.inspection = {
      version: '0.155.0', session: 'present', bindingId: 'bind-b-1', generation: 0,
      platform: 'linux', arch: 'x64',
    };

    await expect(selected.harness.inspect(binding())).resolves.toMatchObject({ support: 'unsupported' });
    await expect(selected.harness.submit({ job: job(), payload: payload() })).resolves.toMatchObject({
      kind: 'failed', errorCode: 'harness_unavailable',
    });
    expect(selected.inbox.deliveries).toEqual([]);
    expect(selected.cli.argv).toEqual([]);
  });

  it('keeps the live proof scoped to Linux x64', async () => {
    const selected = nativeHarness();
    selected.cli.inspection = {
      version: '0.154.0', session: 'present', bindingId: 'bind-b-1', generation: 0,
      platform: 'darwin', arch: 'arm64',
    };

    await expect(selected.harness.inspect(binding())).resolves.toMatchObject({ support: 'unsupported' });
    await expect(selected.harness.submit({ job: job(), payload: payload() })).resolves.toMatchObject({
      kind: 'failed', errorCode: 'harness_unavailable',
    });
    expect(selected.inbox.deliveries).toEqual([]);
  });
});

describe('Codex native CLI notification delivery', () => {
  it('writes the exact released bytes to the inbox and keeps them out of argv', async () => {
    const selected = nativeHarness();
    await selected.harness.inspect(binding());
    const bytes = payload();

    await expect(selected.harness.submit({ job: job(), payload: bytes })).resolves.toMatchObject({
      kind: 'harness_queued', source: 'harness', errorCode: null,
    });
    expect(selected.inbox.deliveries).toHaveLength(1);
    expect(selected.inbox.deliveries[0]).toMatchObject({
      releaseId: 'rel-b-7', bindingId: 'bind-b-1', generation: 0, payloadDigest: job().payloadDigest,
    });
    expect(selected.inbox.deliveries[0]!.payload).toEqual(bytes);
    expect(selected.cli.argv).toEqual([[
      'queue', '--thread', 'session-b', '--message',
      'Khala release rel-b-7 is ready in the local inbox. Run khala listen.',
    ]]);
    expect(JSON.stringify(selected.cli.argv)).not.toContain('quarterly numbers');
  });

  it.each([
    ['a non-zero exit', { status: 'exited', code: 1 } as const, 'harness_rejected'],
    ['a process that did not start', { status: 'not_started' } as const, 'harness_unavailable'],
    ['a killed process', { status: 'lost', cause: 'disconnected' } as const, 'disconnected'],
    ['an overdue process', { status: 'lost', cause: 'timeout' } as const, 'timeout'],
  ])('reports %s as outcome_unknown and never queues the release twice', async (_name, outcome, errorCode) => {
    const selected = nativeHarness();
    selected.cli.outcome = outcome;
    await selected.harness.inspect(binding());

    await expect(selected.harness.submit({ job: job(), payload: payload() })).resolves.toMatchObject({
      kind: 'outcome_unknown', errorCode,
    });
    await expect(selected.harness.submit({ job: job(), payload: payload() })).resolves.toMatchObject({
      kind: 'outcome_unknown',
    });
    expect(selected.inbox.deliveries).toHaveLength(1);
    expect(selected.cli.argv).toHaveLength(1);
  });

  it('times out a never-settling native run and never notifies the release twice', async () => {
    const selected = nativeHarness();
    selected.cli.outcome = never<CodexNativeCliOutcome>();
    const shortDeadlineHarness = createCodexHarness({
      client: selected.server,
      hosts: selected.hosts,
      codec: new FakeCodec(),
      clock,
      evidence: new RecordingSink(),
      limits,
      deadlines: { ...deadlines, callMs: 5 },
      nativeCli: selected.cli,
      nativeInbox: selected.inbox,
    });
    await shortDeadlineHarness.inspect(binding());

    await expect(shortDeadlineHarness.submit({ job: job(), payload: payload() })).resolves.toMatchObject({
      kind: 'outcome_unknown', errorCode: 'timeout',
    });
    await expect(shortDeadlineHarness.submit({ job: job(), payload: payload() })).resolves.toMatchObject({
      kind: 'outcome_unknown',
    });
    expect(selected.inbox.deliveries).toHaveLength(1);
    expect(selected.cli.argv).toHaveLength(1);
  });

  it('does not notify when the durable inbox reports a duplicate', async () => {
    const selected = nativeHarness();
    selected.inbox.result = 'duplicate';
    await selected.harness.inspect(binding());

    await expect(selected.harness.submit({ job: job(), payload: payload() })).resolves.toMatchObject({
      kind: 'outcome_unknown', errorCode: 'harness_unavailable',
    });
    await expect(selected.harness.submit({ job: job(), payload: payload() })).resolves.toMatchObject({
      kind: 'outcome_unknown',
    });
    expect(selected.inbox.deliveries).toHaveLength(1);
    expect(selected.cli.argv).toEqual([]);
  });

  it('requires a non-empty native queue receipt before reporting acceptance', async () => {
    const selected = nativeHarness();
    selected.cli.outcome = { status: 'queued', queueId: '' };
    await selected.harness.inspect(binding());

    await expect(selected.harness.submit({ job: job(), payload: payload() })).resolves.toMatchObject({
      kind: 'outcome_unknown', errorCode: null,
    });
  });

  it('refuses stale generations and digest mismatches before either native port is called', async () => {
    const selected = nativeHarness();
    await selected.harness.inspect(binding());

    await expect(selected.harness.submit({ job: job('rel-stale', binding({ generation: 1 })), payload: payload() }))
      .resolves.toMatchObject({ kind: 'failed', errorCode: 'stale_binding' });
    await expect(selected.harness.submit({ job: job(), payload: payload('changed after release') }))
      .resolves.toMatchObject({ kind: 'failed', errorCode: 'payload_digest_mismatch' });
    expect(selected.inbox.deliveries).toEqual([]);
    expect(selected.cli.argv).toEqual([]);
  });

  it('returns null from route-A reconciliation and never treats null as permission to resend', async () => {
    const selected = nativeHarness();
    await selected.harness.inspect(binding());
    selected.cli.outcome = { status: 'lost', cause: 'disconnected' };
    await selected.harness.submit({ job: job(), payload: payload() });

    await expect(selected.harness.reconcile(job())).resolves.toBeNull();
    await selected.harness.submit({ job: job(), payload: payload() });
    expect(selected.cli.argv).toHaveLength(1);
  });
});
