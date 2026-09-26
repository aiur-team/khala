import { describe, expect, it } from 'vitest';
import fixture from '../../fixtures/delivery/opencode.json';
import { decodeDeliveryLimits } from './decode';
import { type HarnessCapabilities, decodeHarnessCapabilities } from './harness';
import type { BindingId } from './ids';
import {
  OPENCODE_HINT_MAX_BYTES, OPENCODE_NEXT_TURN_ONLY_REASON, OPENCODE_ROUTE_EVIDENCE, OPENCODE_TESTED_VERSIONS,
  type OpenCodeRouteEvidenceKey,
  decodeOpenCodeInboxHint, decodeOpenCodeRouteEvidenceKey, encodeOpenCodeInboxHint, isRecordedOpenCodeRoute,
  openCodeModeSupport, openCodePluginCapabilities, resolveOpenCodeModes,
} from './opencode';

const limits = (() => {
  const decoded = decodeDeliveryLimits(fixture.limits);
  if (!decoded.ok) throw new Error('fixture limits must decode');
  return decoded.value;
})();

function set<T>(base: T, changes: Record<string, unknown>): T {
  const copy = structuredClone(base) as Record<string, unknown>;
  for (const [path, value] of Object.entries(changes)) {
    const keys = path.split('.');
    let target = copy;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    target[keys.at(-1) as string] = structuredClone(value);
  }
  return copy as T;
}

const capabilities = (() => {
  const decoded = decodeHarnessCapabilities(fixture.capabilities);
  if (!decoded.ok) throw new Error(`fixture capabilities failed at ${decoded.field}`);
  return decoded.value;
})();

describe('OpenCode route evidence keys', () => {
  it('records exactly the five 1.17.10 routes from the retained interactive proof', () => {
    expect(OPENCODE_TESTED_VERSIONS).toEqual(['1.17.10']);
    expect(OPENCODE_ROUTE_EVIDENCE.map(key => [key.mode, key.sessionState])).toEqual([
      ['steer', 'busy'], ['steer', 'idle'], ['sync', 'busy'], ['sync', 'idle'], ['async', 'on_read'],
    ]);
    for (const key of OPENCODE_ROUTE_EVIDENCE) {
      expect(decodeOpenCodeRouteEvidenceKey(key)).toEqual({ ok: true, value: key });
      expect(key).toMatchObject({
        surface: 'in_process_plugin', sessionOrigin: 'agent_launched_default_settings',
        retainedCommandsRef: 'experiments/interactive-cli/opencode/README.md#reproduce',
      });
    }
  });

  it.each(fixture.wrongKeys)('refuses a key claim: $name', ({ base, set: changes }) => {
    const claim = set(OPENCODE_ROUTE_EVIDENCE[base] as OpenCodeRouteEvidenceKey, changes);
    expect(decodeOpenCodeRouteEvidenceKey(claim).ok).toBe(true);
    expect(isRecordedOpenCodeRoute(claim)).toBe(false);
    const modes = openCodeModeSupport(claim.harnessVersion, [claim]);
    expect(modes[claim.mode].status).toBe('unknown');
  });

  it('refuses server-session steer even alongside the recorded idle route', () => {
    const serverSteer = set(OPENCODE_ROUTE_EVIDENCE[0] as OpenCodeRouteEvidenceKey, { surface: 'server_session' });
    const modes = openCodeModeSupport('1.17.10', [serverSteer, OPENCODE_ROUTE_EVIDENCE[1]!]);
    expect(modes.steer).toMatchObject({ status: 'unknown', evidenceRef: null, evidenceRevision: null });
  });
});

describe('OpenCode plugin capabilities', () => {
  it('reports the fixture exactly for every recorded key, with next-call acknowledgement', () => {
    const built = openCodePluginCapabilities({ version: '1.17.10', limits, claims: OPENCODE_ROUTE_EVIDENCE });
    expect(built).toEqual(fixture.capabilities);
    expect(JSON.stringify(decodeHarnessCapabilities(built))).toBe(JSON.stringify({ ok: true, value: fixture.capabilities }));
    expect(resolveOpenCodeModes(built)).toEqual(built.modes);
  });

  it('claims idle delivery only when the idle route key matches', () => {
    const busyOnly = OPENCODE_ROUTE_EVIDENCE.filter(key => key.sessionState !== 'idle');
    const built = openCodePluginCapabilities({ version: '1.17.10', limits, claims: busyOnly });
    expect(built.modes.steer).toEqual(fixture.nextTurnOnly.steer);
    expect(built.modes.sync).toEqual(fixture.nextTurnOnly.sync);
    expect(built.modes.steer.reason).toBe(OPENCODE_NEXT_TURN_ONLY_REASON);
    expect(resolveOpenCodeModes(built)).toEqual(built.modes);
  });

  it('never proves steer or sync from the idle route alone', () => {
    const idleOnly = OPENCODE_ROUTE_EVIDENCE.filter(key => key.sessionState === 'idle');
    const modes = openCodeModeSupport('1.17.10', idleOnly);
    expect([modes.steer.status, modes.sync.status, modes.async.status]).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('fails closed for an unrecorded version or a claim set that proves nothing', () => {
    for (const built of [
      openCodePluginCapabilities({ version: '1.17.11', limits, claims: OPENCODE_ROUTE_EVIDENCE }),
      openCodePluginCapabilities({ version: '1.17.10', limits, claims: [] }),
    ]) {
      expect(built).toMatchObject({
        support: 'unsupported', existingSession: 'unknown', immediateNotification: 'unknown', acknowledgement: 'unknown',
      });
      expect(Object.values(built.modes).map(mode => mode.status)).toEqual(['unknown', 'unknown', 'unknown']);
    }
  });

  it.each(fixture.wrongCapabilities)('resolves to unproven: $name', ({ set: changes, modes }) => {
    const decoded = decodeHarnessCapabilities(set(fixture.capabilities, changes));
    if (!decoded.ok) throw new Error(`wrong fixture must still decode (${decoded.field})`);
    const resolved = resolveOpenCodeModes(decoded.value as HarnessCapabilities);
    for (const mode of modes as ('steer' | 'sync' | 'async')[]) {
      expect(resolved[mode]).toMatchObject({ status: 'unknown', evidenceRef: null, evidenceRevision: null });
    }
  });

  it('keeps capability rows the recorded keys produce', () => {
    expect(resolveOpenCodeModes(capabilities)).toEqual(capabilities.modes);
  });
});

describe('OpenCode notifier hint wire format', () => {
  const hint = {
    v: 1, kind: 'khala.inbox.hint', bindingId: 'binding-1' as BindingId, generation: 3, reason: 'released',
  } as const;

  it('encodes one content-free line and round-trips it', () => {
    const line = encodeOpenCodeInboxHint(hint);
    expect(line).toBe(fixture.hints.valid[0]);
    expect(decodeOpenCodeInboxHint(line)).toEqual({ ok: true, value: hint });
    expect(decodeOpenCodeInboxHint(fixture.hints.valid[1]!)).toMatchObject({ ok: true, value: { reason: 'catch_up' } });
  });

  it('encodes only the wire fields even when handed extra properties', () => {
    const smuggled = { ...hint, body: 'hello', batchToken: 'batch-1' } as typeof hint;
    expect(encodeOpenCodeInboxHint(smuggled)).toBe(fixture.hints.valid[0]);
  });

  it.each(fixture.hints.invalid)('refuses a hint line: $name', ({ line }) => {
    expect(decodeOpenCodeInboxHint(line).ok).toBe(false);
  });

  it('refuses an oversized line', () => {
    const line = `${' '.repeat(OPENCODE_HINT_MAX_BYTES)}${fixture.hints.valid[0]}`;
    expect(decodeOpenCodeInboxHint(line)).toEqual({ ok: false, code: 'limit_exceeded', field: '' });
  });
});
