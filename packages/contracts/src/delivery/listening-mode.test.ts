import { describe, expect, it } from 'vitest';
import {
  ACKNOWLEDGEMENT_SUPPORT, LISTENING_MODES, MODE_SUPPORT_STATUSES,
  decodeListeningModeCommand, decodeListeningModeResult, decodeModeSupport,
  decodeOwnerRouteGrantCommand, initialListeningMode, routeGrantMatches,
  type ModeSupportMap, type RouteGrant,
} from './listening-mode';

const proven = {
  status: 'proven',
  route: 'codex-hooks-sync',
  testedVersion: '0.154.0',
  evidenceRef: 'docs/evidence/codex-hooks.md',
  evidenceRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  reason: null,
} as const;

const unknown = (route: string) => ({
  status: 'unknown' as const,
  route,
  evidenceRef: null,
  evidenceRevision: null,
  reason: 'This exact interactive route has not been inspected.',
});

describe('listening-mode values and support', () => {
  it('pins the finite mode, support and acknowledgement vocabularies', () => {
    expect(LISTENING_MODES).toEqual(['steer', 'sync', 'async']);
    expect(MODE_SUPPORT_STATUSES).toEqual([
      'proven', 'experimental', 'blocked_without_wrapper', 'unsupported', 'unknown',
    ]);
    expect(ACKNOWLEDGEMENT_SUPPORT).toEqual(['unknown', 'unsupported', 'batch_token_next_call']);
  });

  it.each([
    proven,
    { ...proven, status: 'experimental', reason: 'The composed route still needs retained proof.' },
    { ...proven, status: 'blocked_without_wrapper', reason: 'Native routes are exhausted.' },
    {
      status: 'unsupported', route: 'codex-queue-payload', testedVersion: '0.154.0',
      evidenceRef: 'docs/evidence/codex-native-cli.md', evidenceRevision: 'codex-native-cli-v1',
      reason: 'Released bytes would enter argv.',
    },
    unknown('codex-hooks-steer'),
  ])('decodes an evidence-valid $status support row', support => {
    expect(decodeModeSupport(support)).toEqual({ ok: true, value: support });
  });

  it('rejects blocked_without_wrapper without a reason or immutable evidence revision', () => {
    expect(decodeModeSupport({ ...proven, status: 'blocked_without_wrapper', reason: '' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'reason' });
    expect(decodeModeSupport({ ...proven, status: 'blocked_without_wrapper', reason: 'Needs wrapper.', evidenceRevision: null }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'evidenceRevision' });
  });

  it.each(
    (['proven', 'experimental'] as const).flatMap(status =>
      (['testedVersion', 'evidenceRef', 'evidenceRevision'] as const).flatMap(field =>
        (['missing', null, ''] as const).map(value => [status, field, value] as const),
      ),
    ),
  )('rejects malformed %s evidence rows at %s (%s)', (status, field, value) => {
    const support: Record<string, unknown> = { ...proven, status };
    if (value === 'missing') delete support[field];
    else support[field] = value;
    expect(decodeModeSupport(support)).toEqual({ ok: false, code: 'invalid_field', field });
  });

  it.each([
    [{ ...proven, reason: 1 }, 'reason'],
    [{ ...proven, unexpected: true }, 'unexpected'],
  ])('rejects malformed evidenced rows at %s', (support, field) => {
    expect(decodeModeSupport(support)).toEqual({ ok: false, code: 'invalid_field', field });
  });

  it('rejects unknown and unsupported rows without a concrete reason', () => {
    expect(decodeModeSupport({ ...unknown('codex-sync'), reason: null }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'reason' });
    expect(decodeModeSupport({ ...unknown('codex-sync'), status: 'unsupported', reason: '' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'reason' });
  });
});

describe('mode commands and results', () => {
  const command = {
    v: 1, commandId: 'mode-command-1', bindingId: 'binding-1', expectedBindingGeneration: 2,
    expectedVersion: 4, requested: 'sync', issuedAt: '2026-09-24T12:00:00Z',
  } as const;

  it('decodes a strict versioned set command', () => {
    expect(decodeListeningModeCommand(command)).toEqual({ ok: true, value: command });
    expect(decodeListeningModeCommand({ ...command, acknowledgement: 'batch_token_next_call' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'acknowledgement' });
  });

  it('keeps mode results independent from batch acknowledgement', () => {
    const result = {
      v: 1, commandId: command.commandId, bindingId: command.bindingId, generation: 2,
      outcome: 'applied', version: 5, requested: 'sync', effective: null, reason: 'Route proof pending.',
    } as const;
    expect(decodeListeningModeResult(result)).toEqual({ ok: true, value: result });
    expect(decodeListeningModeResult({ ...result, acknowledgement: 'batch_token_next_call' }))
      .toEqual({ ok: false, code: 'invalid_field', field: 'acknowledgement' });
  });

  it.each(['grant_experimental_route', 'revoke_experimental_route', 'grant_hard_cancel', 'revoke_hard_cancel'] as const)(
    'decodes the owner-only %s command shape',
    kind => {
      const grant = {
        v: 1, kind, commandId: `command-${kind}`, bindingId: 'binding-1', expectedBindingGeneration: 2,
        expectedVersion: 4, route: 'codex-hooks-sync', harnessVersion: '0.154.0',
        evidenceRevision: proven.evidenceRevision, issuedAt: '2026-09-24T12:00:00Z',
      };
      expect(decodeOwnerRouteGrantCommand(grant)).toEqual({ ok: true, value: grant });
    },
  );
});

describe('initial selection and grant invalidation', () => {
  const modes = (sync: ModeSupportMap['sync'], async: ModeSupportMap['async'] = unknown('codex-async')): ModeSupportMap => ({
    steer: unknown('codex-steer'), sync, async,
  });

  it('selects sync normally, including for unknown and wrapper-blocked support', () => {
    expect(initialListeningMode(modes(unknown('codex-sync')))).toEqual({ requested: 'sync', reason: null });
    expect(initialListeningMode(modes({ ...proven, status: 'blocked_without_wrapper', reason: 'Needs wrapper.' })))
      .toEqual({ requested: 'sync', reason: null });
  });

  it('selects async only from an evidenced exact-route negative with proven async support', () => {
    const unsupportedSync = {
      status: 'unsupported' as const, route: 'opencode-plugin-sync', testedVersion: '1.17.10',
      evidenceRef: 'docs/evidence/opencode.md', evidenceRevision: 'opencode-sync-negative-v1',
      reason: 'The exact interactive route has no safe sync boundary.',
    };
    expect(initialListeningMode(modes(unsupportedSync, { ...proven, route: 'opencode-pull', testedVersion: '1.17.10' })))
      .toEqual({ requested: 'async', reason: unsupportedSync.reason });
    expect(initialListeningMode(modes({ ...unsupportedSync, evidenceRevision: null }, proven))).toEqual({ requested: 'sync', reason: null });
  });

  it('invalidates consent on binding, route, harness-version or evidence-revision drift', () => {
    const grant: RouteGrant = {
      v: 1, kind: 'experimental_route', bindingId: 'binding-1' as RouteGrant['bindingId'], generation: 2,
      mode: 'sync', route: proven.route, harnessVersion: proven.testedVersion,
      evidenceRevision: proven.evidenceRevision, grantRevision: 7,
    };
    const input = {
      bindingId: grant.bindingId, generation: 2, grantRevision: 7, mode: 'sync' as const,
      support: { ...proven, status: 'experimental' as const },
    };
    expect(routeGrantMatches(grant, input)).toBe(true);
    expect(routeGrantMatches(grant, { ...input, generation: 3 })).toBe(false);
    expect(routeGrantMatches(grant, { ...input, grantRevision: 8 })).toBe(false);
    expect(routeGrantMatches(grant, { ...input, support: { ...input.support, route: 'other-route' } })).toBe(false);
    expect(routeGrantMatches(grant, { ...input, support: { ...input.support, testedVersion: '0.155.0' } })).toBe(false);
    expect(routeGrantMatches(grant, { ...input, support: { ...input.support, evidenceRevision: 'changed' } })).toBe(false);
    expect(routeGrantMatches({ ...grant, kind: 'hard_cancel' }, input)).toBe(false);
  });
});
