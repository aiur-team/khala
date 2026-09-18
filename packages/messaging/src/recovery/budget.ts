import type { CallOptions, ControlStore, JsonValue, OwnerId } from '@khala/contracts/messaging/index';
import type { RecoveryMaterial } from './restore';

type BudgetRecord = Readonly<{
  v: 1;
  ownerId: OwnerId;
  /** Hash-derived scope code; raw recovery material identifiers are never journaled. */
  scope: string;
  attempts: number;
}>;

type Reservation = 'reserved' | 'exhausted' | 'unavailable';

async function budgetKey(
  ownerId: OwnerId,
  mode: string,
  accountGeneration: number,
  material: RecoveryMaterial,
): Promise<string | null> {
  try {
    const encoded = new TextEncoder().encode(JSON.stringify([ownerId, mode, accountGeneration, material.id, material.version]));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
    return `recovery-budget/${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

function decode(value: JsonValue): BudgetRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as { readonly [key: string]: JsonValue };
  const fields = ['v', 'ownerId', 'scope', 'attempts'];
  if (Object.keys(input).length !== fields.length || !fields.every(field => Object.hasOwn(input, field))) return null;
  if (input.v !== 1 || typeof input.ownerId !== 'string' || input.ownerId === ''
    || typeof input.scope !== 'string' || input.scope === ''
    || !Number.isSafeInteger(input.attempts) || (input.attempts as number) < 0) return null;
  return input as BudgetRecord;
}

/** Durable material-scoped retry budget. Rotating caller operation IDs does not reset it. */
export function recoveryBudget(ownerId: OwnerId, store: ControlStore) {
  async function available(
    input: Readonly<{ mode: string; accountGeneration: number; material: RecoveryMaterial; limit: number }>,
    options?: CallOptions,
  ): Promise<'available' | 'exhausted' | 'unavailable'> {
    const key = await budgetKey(ownerId, input.mode, input.accountGeneration, input.material);
    if (key === null) return 'unavailable';
    const read = await store.read(key, options);
    if (read.kind === 'unavailable') return 'unavailable';
    if (read.kind === 'absent') return 'available';
    const current = decode(read.record.value);
    const scope = key.slice('recovery-budget/'.length);
    if (current === null || current.ownerId !== ownerId || current.scope !== scope) return 'unavailable';
    return current.attempts >= input.limit ? 'exhausted' : 'available';
  }

  async function reserve(
    input: Readonly<{
      operationId: string;
      mode: string;
      accountGeneration: number;
      material: RecoveryMaterial;
      attempt: number;
      limit: number;
    }>,
    options?: CallOptions,
  ): Promise<Reservation> {
    const key = await budgetKey(ownerId, input.mode, input.accountGeneration, input.material);
    if (key === null) return 'unavailable';
    const writeId = `${key}#${input.operationId}.${input.attempt}`;
    for (let conflicts = 0; conflicts < 4; conflicts += 1) {
      const read = await store.read(key, options);
      if (read.kind === 'unavailable') return 'unavailable';
      const current = read.kind === 'record' ? decode(read.record.value) : null;
      if (read.kind === 'record' && current === null) return 'unavailable';
      if (read.kind === 'record' && read.record.operationId === writeId) return 'reserved';
      const scope = key.slice('recovery-budget/'.length);
      if (current && (current.ownerId !== ownerId || current.scope !== scope)) return 'unavailable';
      if ((current?.attempts ?? 0) >= input.limit) return 'exhausted';
      const next: BudgetRecord = {
        v: 1,
        ownerId,
        scope,
        attempts: (current?.attempts ?? 0) + 1,
      };
      const written = await store.compareAndSet({
        key,
        expectedRevision: read.kind === 'record' ? read.record.revision : null,
        operationId: writeId,
        next: { value: next, expiresAt: null },
      }, options);
      if (written.kind === 'applied') return 'reserved';
      if (written.kind === 'conflict') continue;
      if (written.kind === 'outcome_unknown') {
        const resolved = await store.resolve({ key, operationId: writeId }, options);
        if (resolved.kind === 'applied') return 'reserved';
        if (resolved.kind === 'not_applied') continue;
      }
      return 'unavailable';
    }
    return 'unavailable';
  }

  return { available, reserve };
}
