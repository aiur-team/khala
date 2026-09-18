// Messaging device lifecycle. A device is never a human or an agent identity.

import { type Decoded, decodeWith, fail, identifier, literal, nullable, object, safeInteger } from './decode';
import type { CallOptions, Disposer, OperationResult } from './outcomes';

export type DeviceState = 'new' | 'initializing' | 'ready' | 'locked' | 'lost' | 'revoked' | 'failed';

/**
 * Finite public failure codes. Never an SDK error dump, stack or secret.
 */
export const DEVICE_REASONS = [
  'storage_unavailable',
  'storage_cleared',
  'unsupported_environment',
  'key_material_missing',
  'recovery_required',
  'revoked_by_owner',
  'signed_out',
  'initialization_failed',
] as const;

export type DeviceReason = (typeof DEVICE_REASONS)[number];

export type DeviceView = Readonly<{
  /** `null` until the device has a substrate identity. */
  deviceId: string | null;
  state: DeviceState;
  generation: number;
  reason: DeviceReason | null;
}>;

export type DeviceRejection = 'owner_mismatch' | 'unsupported_environment';

export interface DevicePort {
  ensureReady(ownerId: string, options?: CallOptions): Promise<OperationResult<DeviceView, DeviceRejection>>;
  current(): DeviceView;
  /** Listeners receive full views; ignore views whose generation is not current. */
  observe(listener: (view: DeviceView) => void): Disposer;
  stop(options?: CallOptions): Promise<void>;
}

const NEEDS_ID: readonly DeviceState[] = ['ready', 'locked', 'lost', 'revoked'];
const NEEDS_REASON: readonly DeviceState[] = ['locked', 'lost', 'revoked', 'failed'];

export function decodeDeviceView(input: unknown): Decoded<DeviceView> {
  return decodeWith(() => {
    const r = object(input, '', ['deviceId', 'state', 'generation', 'reason']);
    const view: DeviceView = {
      deviceId: nullable(r.field('deviceId'), value => identifier(value, r.at('deviceId'))),
      state: literal(r.field('state'), r.at('state'), ['new', 'initializing', 'ready', 'locked', 'lost', 'revoked', 'failed']),
      generation: safeInteger(r.field('generation'), r.at('generation')),
      reason: nullable(r.field('reason'), value => literal(value, r.at('reason'), DEVICE_REASONS)),
    };
    if (NEEDS_ID.includes(view.state) && view.deviceId === null) fail(r.at('deviceId'), 'invalid_value');
    if (NEEDS_REASON.includes(view.state) !== (view.reason !== null)) fail(r.at('reason'), 'mismatch');
    return view;
  });
}
