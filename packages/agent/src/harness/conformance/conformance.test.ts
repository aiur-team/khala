import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { codex } from '../codex';
import { ADAPTERS } from '../index';
import { harnessInfo } from '@khala/contracts/m1/harness';
import type { HarnessAdapter } from '../adapter';
import type { WakeDriver } from '../../wake/driver';
import { runConformance, type ConformanceResult } from './run';
import { conformanceDrivers } from './drivers';
import { renderConformanceReport, writeConformanceReport } from './report';
import type { FakeHarnessDriver } from './driver';

const results: ConformanceResult[] = [];
// U22 supplies OpenCode's plugin driver and native idle wake. U21 covers the CLI directly.
const testedAdapters = ADAPTERS.filter(adapter => adapter.id !== 'opencode');
const synthetic: HarnessAdapter = { ...codex, id: 'cursor', wakeLadder: [] };
// Until U8 opens wire/state ids, exercise synthetic adapters under a legacy id
// without its pending exception. The adapter syntax and capabilities remain independent.
const capabilities = { ...harnessInfo('codex'), id: 'cursor' };
const driver = conformanceDrivers.codex!;

describe('Tier A conformance', () => {
  it.skip('OpenCode plugin conformance pending U22 #1147', () => {});
  for (const adapter of testedAdapters) {
    it(`${adapter.id} passes required rows`, async () => {
      const harnessDriver = conformanceDrivers[adapter.id];
      expect(harnessDriver, `${adapter.id} must supply a conformance driver`).toBeDefined();
      const result = await runConformance(adapter, harnessDriver!);
      results.push(result);
      expect(result.rows).toHaveLength(11);
      expect(result.rows.some(row => row.status === 'pending')).toBe(false);
      expect(result.rows.filter(row => row.feature !== 'idle wake').every(row => row.status !== 'pending')).toBe(true);
    });
  }
  afterAll(async () => {
    if (results.length === testedAdapters.length) await writeConformanceReport(results);
  });
  it('fails AE4 when idle wake is declared without a waker', async () => {
    await expect(runConformance(synthetic, driver, { capabilities })).rejects.toThrow('idle wake declared but not delivered');
  });
  it('asserts steer absent by actually invoking the tool hook', async () => {
    const adapter: HarnessAdapter = { ...synthetic, codec: { ...codex.codec!, parse(stdin) {
      const parsed = codex.codec!.parse(stdin);
      return parsed?.event === 'tool' ? null : parsed;
    } } };
    const result = await runConformance(adapter, driver, { capabilities: { ...capabilities, steer: false, idleWake: 'none' } });
    expect(result.rows.find(row => row.feature === 'steer')).toEqual({ feature: 'steer', status: 'absent' });
    await expect(runConformance(synthetic, driver, { capabilities: { ...capabilities, steer: false, idleWake: 'none' } }))
      .rejects.toThrow('steer');
  }, 15_000);
  it('supports steer-only identity frames and asserts sync absent without consuming backlog', async () => {
    const adapter: HarnessAdapter = { ...synthetic, codec: { ...codex.codec!, parse(stdin) {
      const parsed = codex.codec!.parse(stdin);
      return parsed?.event === 'stop' ? { ...parsed, continuation: true } : parsed;
    } } };
    const noSync = { ...capabilities, sync: false, idleWake: 'none' as const };
    const result = await runConformance(adapter, driver, { capabilities: noSync });
    expect(result.rows.find(row => row.feature === 'you=')?.status).toBe('pass');
    expect(result.rows.find(row => row.feature === 'sync')).toEqual({ feature: 'sync', status: 'absent' });
    const consuming: HarnessAdapter = { ...synthetic, codec: { ...codex.codec!, render(kind, frame) {
      return kind === 'stop' ? '' : codex.codec!.render(kind, frame);
    } } };
    await expect(runConformance(consuming, driver, { capabilities: noSync }))
      .rejects.toThrow('absent sync must not consume backlog');
  }, 15_000);
  it('requires verified delivery, records opt-in consent, and rejects an unverified prompt', async () => {
    function nonceFixture(wrongNonce: boolean) {
      let prompt: string | undefined;
      const wake: WakeDriver = { id: 'fixture', rung: 1, optIn: true, minIdleMs: 0, deadlineMs: 3_000,
        verification: 'nonce', available: () => true,
        wake: (_ctx, line) => { prompt = wrongNonce ? line.replace(/k-([0-9a-f])/, (_match, digit: string) => `k-${digit === '0' ? '1' : '0'}`) : line; } };
      const adapter = { ...synthetic, wakeLadder: [wake] };
      const probe: FakeHarnessDriver = { ...driver, wakeProbe: () => ({ drivers: adapter.wakeLadder, prompt: () => prompt }) };
      return { adapter, probe };
    }
    const valid = nonceFixture(false);
    const result = await runConformance(valid.adapter, valid.probe, { capabilities: { ...capabilities, idleWake: 'opt-in' } });
    expect(result.rows.find(row => row.feature === 'idle wake')?.status).toBe('pass');
    const invalid = nonceFixture(true);
    await expect(runConformance(invalid.adapter, invalid.probe, { capabilities: { ...capabilities, idleWake: 'opt-in' } }))
      .rejects.toThrow('idle wake');
  }, 15_000);
  it('rejects mixed verified and unverified transports outside the Claude watcher exception', async () => {
    const verified: WakeDriver = { id: 'verified', rung: 1, optIn: true, minIdleMs: 0, deadlineMs: 3_000,
      verification: 'nonce', available: () => true, wake: () => {} };
    const unverified: WakeDriver = { ...verified, id: 'watcher', verification: 'none' };
    const adapter = { ...synthetic, wakeLadder: [verified, unverified] };
    const probe = { ...driver, wakeProbe: () => ({ drivers: adapter.wakeLadder, prompt: () => undefined }) };
    await expect(runConformance(adapter, probe, { capabilities })).rejects.toThrow('unverified transport');
  });
  it('rejects an opt-in registry entry with an ungated driver', async () => {
    const wake: WakeDriver = { id: 'fixture', rung: 1, optIn: false, minIdleMs: 0, deadlineMs: 3_000,
      verification: 'nonce', available: () => true, wake: () => {} };
    const adapter = { ...synthetic, wakeLadder: [wake] };
    const probe = { ...driver, wakeProbe: () => ({ drivers: [wake], prompt: () => undefined }) };
    await expect(runConformance(adapter, probe, { capabilities: { ...capabilities, idleWake: 'opt-in' } }))
      .rejects.toThrow('opt-in idle wake must require recorded consent');
  });
  it('does not count transport acceptance without prompt nonce verification', async () => {
    let prompt: string | undefined;
    const wake: WakeDriver = { id: 'fixture', rung: 1, optIn: false, minIdleMs: 0, deadlineMs: 3_000,
      verification: 'nonce', available: () => true, wake: (_ctx, line) => { prompt = line; } };
    const codec = { ...codex.codec!, parse(stdin: string) {
      const parsed = codex.codec!.parse(stdin);
      if (parsed) delete parsed.promptText;
      return parsed;
    } };
    const adapter = { ...synthetic, codec, wakeLadder: [wake] };
    const probe = { ...driver, wakeProbe: () => ({ drivers: [wake], prompt: () => prompt }) };
    await expect(runConformance(adapter, probe, { capabilities })).rejects.toThrow('nonce not verified');
  });
  it('writes the full matrix only when report generation is requested', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-conformance-report-'));
    const matrix: ConformanceResult[] = [{ harness: 'claude', rows: [
      { feature: 'idle wake', status: 'pending', detail: 'U14 #1135' }, { feature: 'steer', status: 'pass' },
    ] }, { harness: 'cursor', rows: [{ feature: 'idle wake', status: 'absent' }, { feature: 'steer', status: 'pass' }] }];
    try {
      expect(await writeConformanceReport(matrix, { root, env: {} })).toBeUndefined();
      expect(await fs.readdir(root)).toEqual([]);
      const target = await writeConformanceReport(matrix, { root, env: { KHALA_CONFORMANCE_REPORT: '1' } });
      expect(await fs.readFile(target!, 'utf8')).toBe(renderConformanceReport(matrix));
      expect(renderConformanceReport(matrix)).toContain('PENDING — U14 #1135 | ABSENT (asserted)');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
