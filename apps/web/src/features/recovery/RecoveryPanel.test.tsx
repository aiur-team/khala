import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BindingId, DeviceId, OwnerId, RoomId } from '@khala/contracts/messaging/index';

import { RecoveryPanel } from './RecoveryPanel';
import type { RecoveryController, RecoveryControllerConfig } from './controller';
import type { RecoveryOperation, RecoveryView } from './model';
import type { RecoveryPorts, RevocationCapability } from './ports';

const OWNER_ID = 'owner-a' as OwnerId;
const DEVICE_ID = 'device-a' as DeviceId;
const ROOM_ID = 'room-a' as RoomId;
const BINDING_ID = 'binding-a' as BindingId;

const CONFIG: RecoveryControllerConfig = {
  roomId: ROOM_ID,
  roomRevision: 7,
};

const DEVICE_TARGET: RevocationCapability = {
  targetKind: 'device',
  targetId: DEVICE_ID,
  expectedGeneration: 4,
};

const BINDING_TARGET: RevocationCapability = {
  targetKind: 'binding',
  targetId: BINDING_ID,
  expectedGeneration: 2,
};

function view(overrides: Partial<RecoveryView> = {}): RecoveryView {
  return {
    identityState: 'signed_in',
    deviceState: 'locked',
    deviceId: DEVICE_ID,
    deviceGeneration: 4,
    history: 'unavailable',
    connection: 'online',
    operation: { kind: 'idle' },
    recoveryModes: [],
    recoveryUnavailableReason: 'unsupported_substrate',
    revocationTargets: [DEVICE_TARGET, BINDING_TARGET],
    closure: {
      ownerId: OWNER_ID,
      roomId: ROOM_ID,
      expectedRoomRevision: 7,
      available: true,
      unavailableReason: null,
      consequences: {
        stopsNewMessages: true,
        removesFromOwnerView: true,
        requestsLocalCleanup: true,
        recallsDeliveredCopies: false,
      },
    },
    allowedActions: ['revoke_device', 'revoke_binding', 'close_room'],
    ...overrides,
  };
}

function controller(current: RecoveryView): RecoveryController {
  return {
    getView: () => current,
    subscribe: () => () => {},
    beginRecovery: vi.fn(async () => null),
    beginRevocation: vi.fn(async () => null),
    beginClosure: vi.fn(async () => null),
    inspect: vi.fn(async () => null),
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
}

function unusedPorts(): RecoveryPorts {
  return {} as RecoveryPorts;
}

function render(current: RecoveryView): string {
  return renderToStaticMarkup(
    <RecoveryPanel ports={unusedPorts()} config={CONFIG} controller={controller(current)} onClosureComplete={() => {}} />,
  );
}

type OperationKind = Exclude<RecoveryOperation['kind'], 'idle'>;
type OperationState<K extends OperationKind> = Extract<RecoveryOperation, { kind: K }>['state'];

function operation(kind: 'recovery', state: OperationState<'recovery'>, reason?: string | null): RecoveryOperation;
function operation(kind: 'revocation', state: OperationState<'revocation'>, reason?: string | null): RecoveryOperation;
function operation(kind: 'closure', state: OperationState<'closure'>, reason?: string | null): RecoveryOperation;
function operation(kind: OperationKind, state: string, reason: string | null = null): RecoveryOperation {
  return { kind, operationId: `${kind}-1`, state, reason } as RecoveryOperation;
}

describe('RecoveryPanel state facts', () => {
  it('distinguishes a signed-in identity from missing historical keys', () => {
    const html = render(view());

    expect(html).toContain('Signed in');
    expect(html).toContain('History keys unavailable');
    expect(html).toContain('This device cannot decrypt earlier messages');
    expect(html).toContain('Recovery is not available');
    expect(html).not.toContain('Recovery secret');
    expect(html).not.toContain('Configure');
    expect(html).not.toContain('No messages');
  });

  it('keeps partial history visibly cautionary rather than green', () => {
    const html = render(view({ history: 'partial', deviceState: 'ready' }));

    expect(html).toContain('History partially available');
    expect(html).toContain('Some earlier messages remain unavailable');
    expect(html).toMatch(/status-badge--caution[^>]*>History partially available/);
    expect(html).not.toMatch(/status-badge--positive[^>]*>History partially available/);
  });

  it.each(['not_configured', 'unsupported_substrate', 'device_not_ready', 'signed_out'] as const)(
    'treats recovery refusal %s as unavailable, never as a setup prompt',
    reason => {
      const html = render(view({ recoveryUnavailableReason: reason }));

      expect(html).toContain('Recovery is not available.');
      expect(html).not.toContain('Configure');
      expect(html).not.toContain('Recovery secret');
      expect(html).not.toContain(reason.replaceAll('_', ' '));
    },
  );

  it('does not expose a recovery flow under P14 even if a stale mode appears', () => {
    const html = render(view({
      recoveryModes: ['device_backup'],
      revocationTargets: [DEVICE_TARGET],
      allowedActions: ['recover', 'revoke_device'],
      closure: null,
    }));

    expect(html).not.toContain('Recover with device backup');
    expect(html).toContain(`Revoke device ${DEVICE_ID}`);
    expect(html).not.toContain('Revoke binding');
    expect(html).not.toContain('Close room');
    expect(html.toLowerCase()).not.toContain('escrow');
    expect(html).not.toContain('type="password"');
  });

  it('keeps capability-backed destructive controls disabled for a signed-out or unauthorized viewer', () => {
    const html = render(view({
      identityState: 'signed_out',
      recoveryModes: [],
      revocationTargets: [],
      closure: { ...view().closure!, available: false, unavailableReason: 'forbidden' },
      allowedActions: [],
    }));

    expect(html).toContain('Signed out');
    expect(html).toContain('Recovery and destructive actions are unavailable');
    expect(html).toContain('>Close room<');
    expect(html).toContain('disabled=""');
  });
});

describe('RecoveryPanel operation states', () => {
  it('discloses exact closure consequences without a delete-everywhere promise while pending', () => {
    const html = render(view({
      operation: operation('closure', 'pending'),
      allowedActions: [],
    }));

    expect(html).toContain(`Room ${ROOM_ID}`);
    expect(html).toContain('New messages will stop');
    expect(html).toContain('The room will be removed from your view');
    expect(html).toContain('Local cleanup will be requested on your devices');
    expect(html).toContain('Copies already delivered to participants or models cannot be recalled');
    expect(html).toContain('Service retention is governed separately');
    expect(html.toLowerCase()).not.toContain('delete everywhere');
    expect(html).toContain('Closure pending');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Cancel local wait');
  });

  it('renders partial cleanup as caution with completed and remaining effects', () => {
    const html = render(view({
      operation: operation('closure', 'partial', 'local_cleanup_failed'),
      allowedActions: [],
    }));

    expect(html).toMatch(/status-badge--caution[^>]*>Closure partially complete/);
    expect(html).not.toMatch(/status-badge--positive[^>]*>Closure partially complete/);
    expect(html).toContain('Completed: new messages stopped and the room was removed from your view.');
    expect(html).toContain('Remaining: local cleanup did not complete on every owner device.');
  });

  it('does not invent completed effects for a partial closure without cleanup evidence', () => {
    const html = render(view({
      operation: operation('closure', 'partial', null),
      allowedActions: [],
    }));

    expect(html).toContain('Some room-closure effects completed and some remain unresolved.');
    expect(html).not.toContain('Completed: new messages stopped');
  });

  it('keeps an unknown outcome inspect-only under the same operation ID', () => {
    const html = render(view({
      operation: operation('closure', 'outcome_unknown'),
      allowedActions: [],
    }));

    expect(html).toContain('Closure outcome unknown');
    expect(html).toContain('closure-1');
    expect(html).toContain('Inspect operation');
    expect(html).not.toContain('>Close room<');
    expect(html).not.toContain('Closure complete');
  });

  it.each([
    [operation('recovery', 'restoring'), 'Recovery in progress'],
    [operation('recovery', 'restored'), 'Recovery complete'],
    [operation('recovery', 'partial'), 'Recovery partially complete'],
    [operation('recovery', 'failed'), 'Recovery failed'],
    [operation('recovery', 'unrecoverable'), 'History cannot be recovered'],
    [operation('revocation', 'propagating'), 'Revocation propagating'],
    [operation('revocation', 'complete'), 'Revocation complete'],
    [operation('revocation', 'partial'), 'Revocation partially complete'],
    [operation('revocation', 'failed'), 'Revocation failed'],
    [operation('closure', 'partial'), 'Closure partially complete'],
  ] as const)('renders an operation as %s honestly', (currentOperation, label) => {
    const html = render(view({ operation: currentOperation, allowedActions: [] }));
    expect(html).toContain(label);
    if (
      (currentOperation.kind === 'recovery' && currentOperation.state === 'restoring')
      || (currentOperation.kind === 'revocation' && currentOperation.state === 'propagating')
      || (currentOperation.kind === 'revocation' && currentOperation.state === 'partial')
      || (currentOperation.kind === 'closure' && currentOperation.state === 'partial')
    ) expect(html).toContain('Inspect operation');
  });
});
