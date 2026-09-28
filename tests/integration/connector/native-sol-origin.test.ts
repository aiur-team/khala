import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isolatedNativeModelCall, pinnedNativeAncestor,
  type NativeOriginScope, type NativeProcessSnapshot } from './native-sol-origin';

const scope: NativeOriginScope = {
  sessionId: 'session-sol', cgroup: '/private/khala-42.scope',
  codexHome: '/private/codex-home', fixtureRoot: '/private',
  daemons: [{ pid: 300, startTime: '1234', executable: '/private/codex-home/packages/app-server-daemon/bin/codex',
    cgroup: '/private/khala-42.scope' }],
};
const tool: NativeProcessSnapshot = { pid: 302, parentPid: 301, startTime: '1236', executable: '/usr/bin/node',
  cgroup: scope.cgroup, environment: [] };
const shell: NativeProcessSnapshot = { pid: 301, parentPid: 300, startTime: '1235', executable: '/bin/sh',
  cgroup: scope.cgroup, environment: [] };
const daemon: NativeProcessSnapshot = { pid: 300, parentPid: 1, startTime: '1234',
  executable: scope.daemons[0]!.executable, cgroup: scope.cgroup,
  environment: [`CODEX_HOME=${scope.codexHome}`, `KHALA_42_SYNC_ROOT=${scope.fixtureRoot}`] };

describe('native Sol proof origin', () => {
  it('accepts a tool launched by the pinned app-server daemon for the exact session', () => {
    assert.equal(pinnedNativeAncestor([tool, shell, daemon], scope, 'session-sol'), 300);
  });
  it('refuses another session, a foreign scope, and an unpinned generic Codex process', () => {
    assert.equal(pinnedNativeAncestor([tool, shell, daemon], scope, 'other-session'), null);
    assert.equal(pinnedNativeAncestor([{ ...tool, cgroup: '/foreign' }, shell, daemon], scope, 'session-sol'), null);
    assert.equal(pinnedNativeAncestor([tool, shell, { ...daemon, pid: 400 }], scope, 'session-sol'), null);
  });
  it('refuses PID reuse, a different executable, or another Codex home/root', () => {
    assert.equal(pinnedNativeAncestor([tool, shell, { ...daemon, startTime: '9999' }], scope, 'session-sol'), null);
    assert.equal(pinnedNativeAncestor([tool, shell, { ...daemon, executable: '/usr/bin/codex' }], scope,
      'session-sol'), null);
    assert.equal(pinnedNativeAncestor([tool, shell, { ...daemon, environment: ['CODEX_HOME=/foreign',
      `KHALA_42_SYNC_ROOT=${scope.fixtureRoot}`] }], scope, 'session-sol'), null);
    assert.equal(pinnedNativeAncestor([tool, shell, { ...daemon, environment: [`CODEX_HOME=${scope.codexHome}`,
      'KHALA_42_SYNC_ROOT=/foreign'] }], scope, 'session-sol'), null);
  });
  it('accepts isolated tool execution only for the current batch and a native model-originated call', () => {
    const worker = { ...tool, pid: 2, parentPid: 1, environment: [`CODEX_HOME=${scope.codexHome}`,
      `KHALA_42_SYNC_ROOT=${scope.fixtureRoot}`] };
    const nativeCalls = new Set(['exact-digest']);
    assert.equal(isolatedNativeModelCall([worker], scope, 'session-sol', 'exact-digest', nativeCalls,
      'exact-digest'), true);
    assert.equal(isolatedNativeModelCall([worker], scope, 'foreign-session', 'exact-digest', nativeCalls,
      'exact-digest'), false);
    assert.equal(isolatedNativeModelCall([worker], scope, 'session-sol', 'foreign-digest', nativeCalls,
      'foreign-digest'), false);
    assert.equal(isolatedNativeModelCall([worker], scope, 'session-sol', 'exact-digest', nativeCalls,
      'other-current-batch'), false);
    assert.equal(isolatedNativeModelCall([{ ...worker, cgroup: '/foreign' }], scope, 'session-sol',
      'exact-digest', nativeCalls, 'exact-digest'), false);
    assert.equal(isolatedNativeModelCall([{ ...worker, environment: [] }], scope, 'session-sol',
      'exact-digest', nativeCalls, 'exact-digest'), false);
    assert.equal(isolatedNativeModelCall([worker, daemon], scope, 'session-sol',
      'exact-digest', nativeCalls, 'exact-digest'), false);
  });
});
