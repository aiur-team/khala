import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkBoundaries } from './check-boundaries.mjs';

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

test('invalid browser import makes the command fail for CI', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-boundary-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'apps/web/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps/web/src/invalid.ts'), "import 'node:fs';");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-boundaries.mjs', import.meta.url)), root], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /server-only dependency/);
});
