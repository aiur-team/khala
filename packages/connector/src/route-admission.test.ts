import {
  type HarnessCapabilities, OPENCODE_ROUTE_EVIDENCE, decodeDeliveryLimits, decodeHarnessCapabilities,
  openCodePluginCapabilities,
} from '@khala/contracts/delivery/index';
import fixture from '../../contracts/fixtures/delivery/opencode.json';
import { describe, expect, it } from 'vitest';
import { admitsExistingSessionRoute } from './route-admission';

const limits = (() => {
  const decoded = decodeDeliveryLimits(fixture.limits);
  if (!decoded.ok) throw new Error('fixture limits must decode');
  return decoded.value;
})();

function decoded(input: unknown): HarnessCapabilities {
  const result = decodeHarnessCapabilities(input);
  if (!result.ok) throw new Error(`capabilities failed at ${result.field}`);
  return result.value;
}

function set(changes: Record<string, unknown>): HarnessCapabilities {
  const copy = structuredClone(fixture.capabilities) as Record<string, unknown>;
  for (const [path, value] of Object.entries(changes)) {
    const keys = path.split('.');
    let target = copy;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    target[keys.at(-1) as string] = structuredClone(value);
  }
  return decoded(copy);
}

describe('OpenCode plugin route admission', () => {
  it('admits the recorded 1.17.10 plugin route for an OpenCode binding only', () => {
    const capabilities = decoded(fixture.capabilities);
    expect(admitsExistingSessionRoute(capabilities, 'opencode')).toBe(true);
    expect(admitsExistingSessionRoute(capabilities, 'codex')).toBe(false);
  });

  it('admits a busy-only claim that carries the next-turn caveat', () => {
    const busyOnly = OPENCODE_ROUTE_EVIDENCE.filter(key => key.sessionState !== 'idle');
    expect(admitsExistingSessionRoute(
      openCodePluginCapabilities({ version: '1.17.10', limits, claims: busyOnly }), 'opencode',
    )).toBe(true);
  });

  it.each(fixture.wrongCapabilities)('refuses: $name', ({ set: changes }) => {
    expect(admitsExistingSessionRoute(set(changes), 'opencode')).toBe(false);
  });

  it('refuses a stale version, a claim set that proves nothing, and a mismatched route pair', () => {
    expect(admitsExistingSessionRoute(
      openCodePluginCapabilities({ version: '1.17.11', limits, claims: OPENCODE_ROUTE_EVIDENCE }), 'opencode',
    )).toBe(false);
    expect(admitsExistingSessionRoute(
      openCodePluginCapabilities({ version: '1.17.10', limits, claims: [] }), 'opencode',
    )).toBe(false);
    expect(admitsExistingSessionRoute(set({ immediateNotification: 'native_cli_queue' }), 'opencode')).toBe(false);
    expect(admitsExistingSessionRoute(set({ support: 'experimental' }), 'opencode')).toBe(false);
    expect(admitsExistingSessionRoute(set({ harness: 'codex' }), 'codex')).toBe(false);
  });

  it('refuses when every mode is honestly unproven', () => {
    const unproven = { status: 'unknown', testedVersion: '1.17.10', evidenceRef: null, evidenceRevision: null, reason: 'Unproven.' };
    expect(admitsExistingSessionRoute(set({
      'modes.steer': { ...unproven, route: 'opencode-plugin-steer' },
      'modes.sync': { ...unproven, route: 'opencode-plugin-sync' },
      'modes.async': { ...unproven, route: 'opencode-plugin-async' },
    }), 'opencode')).toBe(false);
  });
});
