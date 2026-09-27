import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialTrustState } from '@khala/policy/trust/index';
import type { BindingId, OwnerId, RoomId } from '@khala/contracts/delivery/index';
import { openTrustStateStore } from './trust-store';

const bindingId = 'binding_trust_hosted' as BindingId;
const baseline = initialTrustState({ bindingId, ownerId: 'owner_trust_hosted' as OwnerId,
  roomId: 'room_trust_hosted' as RoomId, generation: 0, policyVersion: 0 });

describe('hosted owner policy journal', () => {
  it('keeps policy state and idempotency maps across a connector restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-trust-hosted-'));
    try {
      const first = await openTrustStateStore({ directory, mode: 'create' });
      expect(await first.read(bindingId)).toBeNull();
      await first.update(bindingId, () => ({ next: baseline, result: true }));
      first.close();
      const restarted = await openTrustStateStore({ directory, mode: 'existing' });
      expect(await restarted.read(bindingId)).toEqual(baseline);
      restarted.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('creates a missing journal during an additive upgrade of an existing connector state', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-trust-upgrade-'));
    try {
      const upgraded = await openTrustStateStore({ directory, mode: 'existing' });
      await upgraded.update(bindingId, () => ({ next: baseline, result: undefined }));
      expect(await upgraded.read(bindingId)).toEqual(baseline);
      upgraded.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
