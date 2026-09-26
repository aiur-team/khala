import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildGraph, checkBoundaries } from './check-boundaries.mjs';

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-boundaries-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return checkBoundaries(root);
}

test('browser can consume contracts', t => {
  assert.deepEqual(fixture(t, {
    'apps/web/src/chat.ts': "import type { Room } from '../../../packages/contracts/src/messaging/room';",
    'packages/contracts/src/messaging/room.ts': 'export type Room = string;',
  }), []);
});
test('browser cannot reach native code through a dynamic import and a re-export', t => {
  const errors = fixture(t, {
    'apps/web/src/chat.ts': "import('./bridge');",
    'apps/web/src/bridge.ts': "export * from './native';",
    'apps/web/src/native.ts': "import fs from 'node:fs';",
  });
  assert(errors.some(error => error.includes('chat.ts') && error.includes('./bridge -> ./native -> node:fs')));
});
test('browser cannot escape the checked graph through an internal infra module', t => {
  const errors = fixture(t, {
    'apps/web/src/chat.ts': "import './bridge';",
    'apps/web/src/bridge.ts': "import '../../../infra/server';",
    'infra/server.ts': "import 'node:fs';",
  });
  assert(errors.some(error => error.includes('chat.ts') && error.includes('local module outside the checked graph') && error.includes('./bridge -> ../../../infra/server')));
});
test('browser can still import reviewed third-party dependencies', t => {
  assert.deepEqual(fixture(t, {
    'apps/web/src/chat.ts': "import { value } from 'browser-library'; export { value };",
    'node_modules/browser-library/package.json': { name: 'browser-library', types: './index.d.ts' },
    'node_modules/browser-library/index.d.ts': 'export declare const value: string;',
  }), []);
});
test('TS path aliases cannot bypass owner storage restriction', t => {
  const errors = fixture(t, {
    'apps/web/tsconfig.json': { compilerOptions: { baseUrl: '../..', paths: { '@owner/*': ['packages/connector/src/*'] } } },
    'apps/web/src/chat.ts': "import('@owner/storage/keys');",
    'packages/connector/src/storage/keys.ts': 'export const key = 1;',
  });
  assert(errors.some(error => error.includes('browser reaches owner/server')));
});
test('workspace subpath exports enforce the same boundaries before install', t => {
  const errors = fixture(t, {
    'apps/web/src/chat.ts': "import '@khala/connector/storage/keys';",
    'packages/connector/package.json': { name: '@khala/connector', exports: { './storage/*': './src/storage/*.ts' } },
    'packages/connector/src/storage/keys.ts': 'export const key = 1;',
  });
  assert(errors.some(error => error.includes('browser reaches owner/server')));
});
test('source-conditioned exports of the published CLI resolve before install', t => {
  const errors = fixture(t, {
    'packages/agent-skill/src/listen/run.ts': "import '@aiur/khala/cli/app';",
    'packages/agent-cli/package.json': { name: '@aiur/khala', exports: { './cli/*': { 'khala-source': './src/cli/*.ts' } } },
    'packages/agent-cli/src/cli/app.ts': 'export {};',
  });
  assert(errors.some(error => error.includes('cross-component implementation requires a composition root')));
  assert(!errors.some(error => error.includes('unresolved workspace')));
});
test('contracts cannot reach apps or the other contract domain', t => {
  const errors = fixture(t, {
    'packages/contracts/src/messaging/room.ts': "import '../../../../apps/control/src/auth'; import '../delivery/approval';",
    'apps/control/src/auth.ts': 'export {};',
    'packages/contracts/src/delivery/approval.ts': 'export {};',
  });
  assert(errors.some(error => error.includes('contracts cannot import implementations')));
  assert(errors.some(error => error.includes('contract domains cannot import each other')));
});
test('policy rejects external I/O and computed imports', t => {
  const errors = fixture(t, { 'packages/policy/src/trust/check.ts': "import 'some-network-sdk'; const module = 'fs'; import(module);" });
  assert(errors.some(error => error.includes('external dependency')));
  assert(errors.some(error => error.includes('unanalyzable')));
});
test('sibling features and unresolved workspace imports fail', t => {
  const errors = fixture(t, {
    'apps/web/src/features/a/index.ts': "import '../b/index'; import '@khala/contracts/messaging/missing';",
    'apps/web/src/features/b/index.ts': 'export {};',
  });
  assert(errors.some(error => error.includes('sibling feature')));
  assert(errors.some(error => error.includes('unresolved workspace')));
});
test('features may import the shared decision shell, which may not import features', t => {
  assert.deepEqual(fixture(t, {
    'apps/web/src/features/channel-access/index.ts': "import '../approval-decision/model';",
    'apps/web/src/features/approval-decision/model.ts': 'export {};',
  }), []);
  const errors = fixture(t, {
    'apps/web/src/features/approval-decision/model.ts': "import '../channel-access/index';",
    'apps/web/src/features/channel-access/index.ts': 'export {};',
  });
  assert(errors.some(error => error.includes('sibling feature') && error.includes('../channel-access/index')));
});
test('the channel-request inbox may import the shared creation adapter', t => {
  assert.deepEqual(fixture(t, {
    'apps/web/src/features/channel-access/model.ts': "import '../channel-create/model';",
    'apps/web/src/features/channel-create/model.ts': "import '../approval-decision/model';",
    'apps/web/src/features/approval-decision/model.ts': 'export {};',
  }), []);
});
test('loopback server imports only built-ins, the internal store and contracts', t => {
  assert.deepEqual(fixture(t, {
    'apps/internal/src/server/server.ts': "import http from 'node:http'; import { store } from '../store/channel-store'; import type { Room } from '../../../../packages/contracts/src/messaging/room';",
    'apps/internal/src/store/channel-store.ts': 'export const store = 1;',
    'packages/contracts/src/messaging/room.ts': 'export type Room = string;',
  }), []);
  const errors = fixture(t, {
    'apps/internal/src/server/server.ts': "import '../composition/root'; import '../../../web/src/app'; import 'express'; import './helper.test';",
    'apps/internal/src/composition/root.ts': 'export {};',
    'apps/web/src/app.ts': 'export {};',
  });
  for (const specifier of ['../composition/root', '../../../web/src/app', 'express']) {
    assert(errors.some(error => error.includes('loopback server may import only') && error.includes(`(${specifier})`)), specifier);
  }
});
const policyPackage = { name: '@khala/policy', exports: { './listening-mode/*': './src/listening-mode/*.ts', './trust/*': './src/trust/*.ts' } };

test('internal composition may import the local automation provider and profile', t => {
  assert.deepEqual(fixture(t, {
    'apps/internal/src/composition/root.ts': "import './local-automation/provider'; import '@khala/policy/listening-mode/limits';",
    'apps/internal/src/composition/local-automation/provider.ts': "import '@khala/policy/listening-mode/limits'; export const marker = 'khala:local-automation-authority';",
    'packages/policy/package.json': policyPackage,
    'packages/policy/src/listening-mode/limits.ts': 'export const limits = {};',
  }), []);
});
test('only the internal composition may import local automation', t => {
  const errors = fixture(t, {
    'apps/internal/src/server/server.ts': "import '@khala/policy/listening-mode/limits';",
    'packages/policy/src/trust/gate.ts': "import '../listening-mode/limits';",
    'packages/policy/package.json': policyPackage,
    'packages/policy/src/listening-mode/limits.ts': 'export const limits = {};',
  });
  for (const origin of ['apps/internal/src/server/server.ts', 'packages/policy/src/trust/gate.ts']) {
    assert(errors.some(error => error.startsWith(origin) && error.includes('importable only from the internal composition')), origin);
  }
});
test('hosted roots cannot reach local automation directly, through a package, or by marker', t => {
  const errors = fixture(t, {
    'apps/control/src/composition/direct.ts': "import '../../../internal/src/composition/local-automation/provider';",
    'apps/internal/src/composition/local-automation/provider.ts': "export const marker = 'khala:local-automation-authority';",
    'apps/connector/src/composition/controls/automation.ts': "import '@khala/connector/relay';",
    'packages/connector/package.json': { name: '@khala/connector', exports: { './*': './src/*.ts' } },
    'packages/connector/src/relay.ts': "export * from '@khala/policy/listening-mode/limits'; import './opener';",
    'packages/connector/src/opener.ts': "export const authority = 'khala:local-automation-authority';",
    'packages/policy/package.json': policyPackage,
    'packages/policy/src/listening-mode/limits.ts': 'export const limits = {};',
    'apps/web/src/marked.ts': "export const authority = 'khala:local-automation-authority';",
  });
  const has = (origin, text) => errors.some(error => error.startsWith(origin) && error.includes(text));
  assert(has('apps/control/src/composition/direct.ts', 'hosted graph reaches local automation'));
  assert(has('apps/connector/src/composition/controls/automation.ts', 'hosted graph reaches local automation (@khala/connector/relay -> @khala/policy/listening-mode/limits)'));
  assert(has('apps/connector/src/composition/controls/automation.ts', 'hosted graph reaches local automation (@khala/connector/relay -> ./opener)'));
  assert(has('apps/web/src/marked.ts', 'hosted source carries the local automation marker'));
});
test('dispatch limits come from the internal composition, never a hosted connector root', t => {
  const files = {
    'apps/internal/src/composition/local-automation/dispatch.ts': "import '@khala/connector/dispatch/index'; import './provider';",
    'apps/internal/src/composition/local-automation/provider.ts': "import '@khala/policy/listening-mode/limits'; export const marker = 'khala:local-automation-authority';",
    'packages/connector/package.json': { name: '@khala/connector', exports: { './dispatch/*': './src/dispatch/*.ts' } },
    'packages/connector/src/dispatch/index.ts': 'export const createDispatcher = () => null;',
    'packages/policy/package.json': policyPackage,
    'packages/policy/src/listening-mode/limits.ts': 'export const limits = {};',
  };
  assert.deepEqual(fixture(t, files), []);
  const errors = fixture(t, {
    ...files,
    'apps/connector/src/composition/agent/dispatch-limits.ts': "import '@khala/connector/dispatch/index'; import '@khala/policy/listening-mode/limits';",
  });
  const origin = 'apps/connector/src/composition/agent/dispatch-limits.ts';
  assert(errors.some(error => error.startsWith(origin) && error.includes('hosted graph reaches local automation')));
  assert(errors.some(error => error.startsWith(origin) && error.includes('importable only from the internal composition')));
});
test('repository: only the internal composition graph carries the local automation marker', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { graph, marked } = buildGraph(root);
  const reach = origin => {
    const seen = new Set([origin]);
    const queue = [origin];
    while (queue.length) for (const edge of graph.get(queue.shift()) ?? []) {
      if (edge.target && !seen.has(edge.target)) { seen.add(edge.target); queue.push(edge.target); }
    }
    return seen;
  };
  const production = [...graph.keys()].filter(file => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
  assert.deepEqual([...marked].filter(file => production.includes(file)), ['apps/internal/src/composition/local-automation/provider.ts']);
  assert(reach('apps/internal/src/composition/local-automation/provider.ts').has('packages/policy/src/listening-mode/limits.ts'));
  const hosted = production.filter(file => /^apps\/(?:web|control|connector)\//.test(file));
  assert(hosted.includes('apps/connector/src/composition/controls/automation.ts'));
  assert(reach('apps/connector/src/composition/controls/automation.ts').has('packages/policy/src/trust/gate.ts'));
  for (const origin of hosted) {
    const leaked = [...reach(origin)].filter(file => marked.has(file) || file.startsWith('apps/internal/') || file === 'packages/policy/src/listening-mode/limits.ts');
    assert.deepEqual(leaked, [], origin);
  }
});

test('the hosted web graph never reaches the internal entry or its loopback transport', t => {
  const errors = fixture(t, {
    'apps/web/src/main.tsx': "import './composition/human/room';",
    'apps/web/src/composition/human/room.ts': "import '../../internal/composition/ports'; import '../../../../../packages/messaging/src/local/http/index';",
    'apps/web/src/internal/composition/ports.ts': 'export const ports = 1;',
    'packages/messaging/src/local/http/index.ts': 'export const substrate = 1;',
  });
  assert(errors.some(error => error.startsWith('apps/web/src/main.tsx: hosted browser graph reaches the internal entry') && error.includes('internal/composition/ports')));
  assert(errors.some(error => error.includes('hosted browser graph reaches the internal entry') && error.includes('messaging/src/local/http')));
});
test('the internal entry never reaches Matrix, join, pairing or recovery code', t => {
  const errors = fixture(t, {
    'apps/web/src/internal/main.tsx': "import './composition/screen';",
    'apps/web/src/internal/composition/screen.tsx': [
      "import '../../composition/human/screen';",
      "import '../../composition/human/mount';",
      "import '../../features/join/JoinScreen';",
      "import '../../composition/recovery/register';",
      "import 'matrix-js-sdk';",
    ].join('\n'),
    'apps/web/src/composition/human/screen.tsx': 'export const screen = 1;',
    'apps/web/src/composition/human/mount.tsx': 'export const mount = 1;',
    'apps/web/src/features/join/JoinScreen.tsx': 'export const join = 1;',
    'apps/web/src/composition/recovery/register.ts': 'export const recovery = 1;',
  });
  const reached = errors.filter(error => error.startsWith('apps/web/src/internal/main.tsx: internal entry reaches hosted-only code'));
  assert.equal(reached.length, 4, errors.join('\n'));
  assert(!errors.some(error => error.includes('human/screen.tsx') && error.includes('hosted-only')));
});
test('repository: the internal entry and the hosted entry stay apart', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkBoundaries(root).filter(error => /internal entry|hosted browser graph/.test(error));
  assert.deepEqual(errors, []);
});
test('invalid browser import makes the command fail for CI', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-boundary-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'apps/web/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps/web/src/invalid.ts'), "import 'node:fs';");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-boundaries.mjs', import.meta.url)), root], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /server-only dependency/);
});
