// Owner → internal messaging account, provisioned without human setup. The
// mapping is resumable: pending mapping → account exists → active mapping. A
// lookup by the stable external ID always precedes a create, so a create whose
// response was lost is adopted on retry instead of duplicated. The mapping holds
// only the protocol account ID: no access token, password or crypto secret.

import { createHash } from 'node:crypto';
import type { CallOptions, ControlStore, OwnerId } from '@khala/contracts/messaging/index';
import { type Random, orUnavailable, randomToken, settleWrite } from './store';

/**
 * Server-side account directory of the selected messaging substrate. Its
 * credential is a least-privileged infrastructure secret that never reaches a
 * browser or endpoint. `externalId` is the owner ID, never an email.
 */
export interface MessagingAccountDirectory {
  lookup(externalId: OwnerId, options?: CallOptions): Promise<
    Readonly<{ kind: 'found'; accountId: string }> | Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'unavailable' }>
  >;
  /** `outcome_unknown`: the account may exist; the next attempt looks it up first. */
  create(externalId: OwnerId, options?: CallOptions): Promise<
    Readonly<{ kind: 'created'; accountId: string }> | Readonly<{ kind: 'unavailable' }> | Readonly<{ kind: 'outcome_unknown' }>
  >;
}

type MappingRecord =
  | { v: 1; ownerId: string; state: 'pending'; accountId: null }
  | { v: 1; ownerId: string; state: 'active'; accountId: string };

export type MessagingAccount =
  | Readonly<{ kind: 'active'; accountId: string }>
  /** Retry later; no chat is ready and no session should be minted. */
  | Readonly<{ kind: 'unavailable' }>
  /** The directory maps this owner to a different account than the stored mapping. */
  | Readonly<{ kind: 'conflict' }>;

export function mappingKey(ownerId: OwnerId): string {
  return `auth.mapping.v1.${createHash('sha256').update(ownerId).digest('hex')}`;
}

export async function ensureMessagingAccount(
  store: ControlStore, directory: MessagingAccountDirectory, random: Random, ownerId: OwnerId,
): Promise<MessagingAccount> {
  const key = mappingKey(ownerId);
  const operation = () => `auth.mapping.${randomToken(random, 18)}`;
  let current = await store.read<MappingRecord>(key);
  if (current.kind === 'unavailable') return { kind: 'unavailable' };
  if (current.kind === 'absent') {
    const pending: MappingRecord = { v: 1, ownerId, state: 'pending', accountId: null };
    const write = await settleWrite(store, { key, expectedRevision: null, operationId: operation(), next: { value: pending, expiresAt: null } });
    if (write.kind === 'unavailable') return { kind: 'unavailable' };
    // A concurrent request created it first; continue from whatever it wrote.
    const record = write.kind === 'applied' ? write.record : write.current;
    if (!record) return { kind: 'unavailable' };
    current = { kind: 'record', record };
  }
  const mapping = current.record.value;
  if (mapping.ownerId !== ownerId) return { kind: 'unavailable' };
  if (mapping.state === 'active') return { kind: 'active', accountId: mapping.accountId };

  const accountId = await findOrCreate(directory, ownerId);
  if (accountId === null) return { kind: 'unavailable' };
  const active: MappingRecord = { v: 1, ownerId, state: 'active', accountId };
  const write = await settleWrite(store, {
    key, expectedRevision: current.record.revision, operationId: operation(), next: { value: active, expiresAt: null },
  });
  if (write.kind === 'applied') return { kind: 'active', accountId };
  if (write.kind === 'conflict' && write.current?.value.state === 'active') {
    // A competing request activated first; agreement converges, disagreement is explicit.
    return write.current.value.accountId === accountId ? { kind: 'active', accountId } : { kind: 'conflict' };
  }
  return { kind: 'unavailable' };
}

async function findOrCreate(directory: MessagingAccountDirectory, ownerId: OwnerId): Promise<string | null> {
  const found = await orUnavailable(() => directory.lookup(ownerId));
  if (found.kind === 'found') return found.accountId;
  if (found.kind !== 'absent') return null;
  const created = await orUnavailable(() => directory.create(ownerId));
  return created.kind === 'created' ? created.accountId : null;
}

/** Read-only view of an owner's mapping for composition code. */
export async function readMessagingAccount(store: ControlStore, ownerId: OwnerId): Promise<
  Readonly<{ kind: 'active'; accountId: string }> | Readonly<{ kind: 'pending' }> | Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'unavailable' }>
> {
  const current = await store.read<MappingRecord>(mappingKey(ownerId));
  if (current.kind !== 'record') return current;
  const mapping = current.record.value;
  if (mapping.ownerId !== ownerId) return { kind: 'unavailable' };
  return mapping.state === 'active' ? { kind: 'active', accountId: mapping.accountId } : { kind: 'pending' };
}
