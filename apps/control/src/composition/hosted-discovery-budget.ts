import { randomBytes } from 'node:crypto';
import type { JsonValue } from '@khala/contracts/messaging/index';
import { guardStore, settleWrite } from '../auth/store';
import type { ProductionHumanRuntime } from './human/production';

const GLOBAL_ATTEMPTS_PER_MINUTE = 300;

/** One durable global budget for anonymous key challenges and credential attempts. */
export async function reserveHostedDiscoveryAttempt(active: ProductionHumanRuntime): Promise<'reserved' | 'limited' | 'unavailable'> {
  const store = guardStore(active.store);
  const window = Math.floor(active.clock() / 60_000);
  const key = `channel-discovery:hosted-attempts:${window}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = await store.read<JsonValue>(key);
    if (read.kind === 'unavailable') return 'unavailable';
    const count = read.kind === 'record' && typeof read.record.value === 'number' ? read.record.value : 0;
    if (read.kind === 'record' && typeof read.record.value !== 'number') return 'unavailable';
    if (count >= GLOBAL_ATTEMPTS_PER_MINUTE) return 'limited';
    const written = await settleWrite<JsonValue>(store, {
      key, expectedRevision: read.kind === 'record' ? read.record.revision : null,
      operationId: `discovery-hosted-budget:${randomBytes(16).toString('base64url')}`,
      next: { value: count + 1, expiresAt: new Date((window + 2) * 60_000).toISOString() },
    });
    if (written.kind === 'applied') return 'reserved';
    if (written.kind === 'unavailable') return 'unavailable';
  }
  return 'unavailable';
}
