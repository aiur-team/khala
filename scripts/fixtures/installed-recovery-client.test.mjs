import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { startRecoveryTransport } from './hosted-recovery.mjs';
import { installRecoveryClient } from './installed-recovery-client.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const item = path.join(directory, entry.name);
    return entry.isDirectory() ? files(item) : [item];
  });
}

test('restarts a packaged and installed Claude MCP entry over the same owned exact-session state', { timeout: 90_000 }, async () => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'khala-recovery-pack-'));
  const fixture = await startRecoveryTransport({ async handle() { return Response.json({ kind: 'unavailable' }, { status: 503 }); } });
  let client;
  try {
    execFileSync(process.execPath, ['packages/agent-cli/scripts/bundle.mjs'], { cwd: repository, stdio: 'ignore', timeout: 60_000 });
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], {
      cwd: path.join(repository, 'packages/agent-cli'), encoding: 'utf8', timeout: 30_000,
    }));
    const chromiumExecutable = chromium.executablePath();
    client = installRecoveryClient({ tarball: path.join(output, packed[0].filename), origin: fixture.origin,
      caFile: fixture.caFile, sessionId: 'controlled-recovery-session', workdir: repository,
      ...(process.platform === 'linux' && existsSync(chromiumExecutable) ? { chromiumExecutable } : {}) });
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'khala_channel_access_status', arguments: { operationId: 'controlled-recovery-operation' },
    } };
    const first = await client.call([message]);
    assert.deepEqual(first.replies[0].result.structuredContent, {
      ok: false, v: 1, error: 'unavailable', operationId: 'controlled-recovery-operation', next: 'reuse_operation_id',
    });
    const ledgers = files(client.stateDirectory).filter(item => item.endsWith('/ledger.sqlite'));
    assert.equal(ledgers.length, 1, `preflight must create actual connector state: ${JSON.stringify(first.diagnostics)}`);
    const inode = statSync(ledgers[0]).ino;
    const second = await client.call([message]);
    assert.notEqual(first.pid, second.pid);
    assert.deepEqual(second.replies, first.replies);
    assert.equal(statSync(ledgers[0]).ino, inode);
    assert.equal(files(client.stateDirectory).filter(item => item.endsWith('/ledger.sqlite')).length, 1);
    assert.equal(fixture.receipt().droppedRedeemResponses, 0);
    console.log(JSON.stringify({ v: 1, scope: 'installed_preflight_only', processes: 2,
      connectorStores: 1, exactSessionStateReused: true, outcome: 'unavailable', droppedRedeemResponses: 0 }));
  } finally {
    client?.close(); await fixture.close(); rmSync(output, { recursive: true, force: true });
  }
});
