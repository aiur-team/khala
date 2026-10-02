import { expect, it, vi } from 'vitest';
import { nameKey, ownerAgentsKey } from '@khala/contracts/m1/names';
import { agentOwnerRecordKey } from '@khala/contracts/m1/participants';
import type { JsonValue, OwnerId } from '@khala/contracts/messaging/index';
import { createControlStore } from '../runtime/control-store';
import { durableStores } from './testing/store';
import { renameAgent, renameDefaultAgents } from './rename';

const ownerId = 'owner' as OwnerId;
const matrixUserId = '@agent:matrix.test';
async function fixture(labels = ['Kevin-Claude']) {
  const clock = () => Date.parse('2026-10-02T12:00:00.000Z');
  const blobs = durableStores();
  const store = createControlStore({ records: blobs.storeFor('records'), operations: blobs.storeFor('operations'), clock });
  let sequence = 0;
  const put = async (key: string, value: JsonValue) => {
    const read = await store.read(key);
    const result = await store.compareAndSet({ key, expectedRevision: read.kind === 'record' ? read.record.revision : null,
      operationId: `seed-${++sequence}`, next: { value, expiresAt: null } });
    expect(result.kind).toBe('applied');
  };
  const ids = labels.map((_, i) => i === 0 ? matrixUserId : `@agent${i}:matrix.test`);
  for (const [i, label] of labels.entries()) {
    const userId = ids[i]!;
    await put(agentOwnerRecordKey(userId), { matrixUserId: userId, ownerId, ownerLabel: 'Kevin', harness: 'claude', label,
      createdAt: new Date(clock()).toISOString() });
    await put(nameKey(label), { v: 1, kind: 'agent', ownerId, matrixUserId: userId });
  }
  await put(ownerAgentsKey(ownerId), { v: 1, ownerId, agents: ids });
  const provisioner = { setDisplayName: vi.fn(async () => true) };
  const label = async (id = matrixUserId) => {
    const read = await store.read(agentOwnerRecordKey(id));
    if (read.kind !== 'record') throw Error('missing owner');
    return (read.record.value as { label: string }).label;
  };
  return { store, clock, provisioner, put, ids, label };
}

it('renames an owned agent globally and replaces its namespace reservation', async () => {
  const f = await fixture();
  expect(await renameAgent(f, ownerId, matrixUserId, 'Reviewer')).toBe('ok');
  expect(await f.label()).toBe('Reviewer');
  expect(f.provisioner.setDisplayName).toHaveBeenCalledWith(matrixUserId, 'Reviewer');
  const claim = await f.store.read(nameKey('Reviewer'));
  expect(claim.kind === 'record' && claim.record.value).toEqual({ v: 1, kind: 'agent', ownerId, matrixUserId });
  expect(await f.store.read(nameKey('Kevin-Claude'))).toEqual({ kind: 'absent' });
});
it('rejects a different owner and unknown agents before touching Matrix', async () => {
  const f = await fixture();
  expect(await renameAgent(f, 'other' as OwnerId, matrixUserId, 'Reviewer')).toBe('not_owner');
  expect(await renameAgent(f, ownerId, '@missing:matrix.test', 'Reviewer')).toBe('not_found');
  expect(f.provisioner.setDisplayName).not.toHaveBeenCalled();
  expect(await f.label()).toBe('Kevin-Claude');
});
it('enforces the shared human namespace and name rules', async () => {
  const f = await fixture();
  await f.put(nameKey('Reviewer'), { v: 1, kind: 'human', ownerId: 'human' });
  expect(await renameAgent(f, ownerId, matrixUserId, 'Reviewer')).toBe('taken');
  expect(await renameAgent(f, ownerId, matrixUserId, 'ab cd')).toBe('invalid');
  expect(f.provisioner.setDisplayName).not.toHaveBeenCalled();
});
it.each([false, 'throw'])('releases a new claim if Matrix update fails (%s)', async failure => {
  const f = await fixture();
  if (failure === 'throw') f.provisioner.setDisplayName.mockRejectedValueOnce(Error('offline'));
  else f.provisioner.setDisplayName.mockResolvedValueOnce(false);
  expect(await renameAgent(f, ownerId, matrixUserId, 'Reviewer')).toBe('unavailable');
  expect(await f.store.read(nameKey('Reviewer'))).toEqual({ kind: 'absent' });
  expect(await f.label()).toBe('Kevin-Claude');
  expect((await f.store.read(nameKey('Kevin-Claude'))).kind).toBe('record');
});
it('supports case-only changes and idempotent retries', async () => {
  const f = await fixture();
  expect(await renameAgent(f, ownerId, matrixUserId, 'kevin-claude')).toBe('ok');
  expect(await f.label()).toBe('kevin-claude');
  expect((await f.store.read(nameKey('Kevin-Claude'))).kind).toBe('record');
  expect(await renameAgent(f, ownerId, matrixUserId, 'kevin-claude')).toBe('ok');
  expect(f.provisioner.setDisplayName).toHaveBeenCalledTimes(1);
});
it('keeps the existing claim when a case-only Matrix update fails', async () => {
  const f = await fixture(); f.provisioner.setDisplayName.mockResolvedValueOnce(false);
  expect(await renameAgent(f, ownerId, matrixUserId, 'kevin-claude')).toBe('unavailable');
  expect((await f.store.read(nameKey('Kevin-Claude'))).kind).toBe('record');
});
it('retries one owner CAS conflict and bounds repeated conflicts', async () => {
  for (const failures of [1, 2]) {
    const f = await fixture(); const write = f.store.compareAndSet;
    let attempts = 0;
    vi.spyOn(f.store, 'compareAndSet').mockImplementation(async (input, options) => {
      if (input.key === agentOwnerRecordKey(matrixUserId) && ++attempts <= failures) {
        const current = await f.store.read(input.key);
        return { kind: 'conflict', current: current.kind === 'record' ? current.record : null };
      }
      return write(input, options);
    });
    expect(await renameAgent(f, ownerId, matrixUserId, 'Reviewer')).toBe(failures === 1 ? 'ok' : 'unavailable');
    expect(attempts).toBe(2);
    expect(await f.label()).toBe(failures === 1 ? 'Reviewer' : 'Kevin-Claude');
  }
});
it('releases reservations on definitely rejected owner writes and fails closed on store failure', async () => {
  const f = await fixture(); const write = f.store.compareAndSet;
  vi.spyOn(f.store, 'compareAndSet').mockImplementation((input, options) => input.key === agentOwnerRecordKey(matrixUserId)
    ? Promise.resolve({ kind: 'unavailable' }) : write(input, options));
  expect(await renameAgent(f, ownerId, matrixUserId, 'Reviewer')).toBe('unavailable');
  expect(await f.store.read(nameKey('Reviewer'))).toEqual({ kind: 'absent' });
  expect(f.provisioner.setDisplayName).toHaveBeenLastCalledWith(matrixUserId, 'Kevin-Claude');
  const g = await fixture(); vi.spyOn(g.store, 'read').mockRejectedValue(Error('offline'));
  expect(await renameAgent(g, ownerId, matrixUserId, 'Reviewer')).toBe('unavailable');
});
it('does not release an old namespace claim held by someone else', async () => {
  const f = await fixture(); await f.put(nameKey('Kevin-Claude'), { v: 1, kind: 'human', ownerId: 'human' });
  expect(await renameAgent(f, ownerId, matrixUserId, 'Reviewer')).toBe('ok');
  expect((await f.store.read(nameKey('Kevin-Claude'))).kind).toBe('record');
});
it('cascades default names with their suffix while leaving custom names alone', async () => {
  const f = await fixture(['Kevin-Claude', 'Kevin-Claude-2', 'Reviewer']);
  await renameDefaultAgents(f, ownerId, 'Kevin', 'Kev');
  expect(await Promise.all(f.ids.map(f.label))).toEqual(['Kev-Claude', 'Kev-Claude-2', 'Reviewer']);
  expect(f.provisioner.setDisplayName).toHaveBeenCalledTimes(2);
});
it('allocates the next available suffix when the preserved suffix is taken', async () => {
  const f = await fixture(['Kevin-Claude-2']);
  for (const name of ['Kev-Claude', 'Kev-Claude-2']) await f.put(nameKey(name), { v: 1, kind: 'human', ownerId: 'human' });
  await renameDefaultAgents(f, ownerId, 'Kevin', 'Kev');
  expect(await f.label()).toBe('Kev-Claude-3');
  expect(await f.store.read(nameKey('Kevin-Claude-2'))).toEqual({ kind: 'absent' });
});
it('does nothing on first username claim or a missing owner index', async () => {
  const f = await fixture();
  await renameDefaultAgents(f, ownerId, null, 'Kev');
  await renameDefaultAgents(f, 'missing' as OwnerId, 'Kevin', 'Kev');
  expect(await f.label()).toBe('Kevin-Claude');
  expect(f.provisioner.setDisplayName).not.toHaveBeenCalled();
});
it('skips missing and foreign index entries and continues after an agent failure', async () => {
  const f = await fixture(['Kevin-Claude', 'Kevin-Claude-2']);
  await f.put(agentOwnerRecordKey('@foreign:matrix.test'), { matrixUserId: '@foreign:matrix.test', ownerId: 'other', ownerLabel: 'Kevin',
    harness: 'claude', label: 'Kevin-Claude-3', createdAt: new Date(f.clock()).toISOString() });
  await f.put(ownerAgentsKey(ownerId), { v: 1, ownerId, agents: ['@missing:matrix.test', '@foreign:matrix.test', ...f.ids] });
  f.provisioner.setDisplayName.mockRejectedValueOnce(Error('offline'));
  await renameDefaultAgents(f, ownerId, 'Kevin', 'Kev');
  expect(await Promise.all(f.ids.map(f.label))).toEqual(['Kevin-Claude', 'Kev-Claude-2']);
  expect(f.provisioner.setDisplayName).toHaveBeenCalledTimes(2);
});
it('does not overwrite a custom label selected after the cascade read', async () => {
  const f = await fixture();
  expect(await renameAgent(f, ownerId, matrixUserId, 'Kev-Claude', 'different-label')).toBe('unavailable');
  expect(f.provisioner.setDisplayName).not.toHaveBeenCalled();
});

it('serializes global renames across separate callers using the durable store lease', async () => {
  const f = await fixture();
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  f.provisioner.setDisplayName.mockImplementationOnce(async () => { enter(); await blocked; return true; });
  const first = renameAgent(f, ownerId, matrixUserId, 'Reviewer');
  await entered;
  const other = { ...f, provisioner: { setDisplayName: vi.fn(async () => true) } };
  expect(await renameAgent(other, ownerId, matrixUserId, 'Writer')).toBe('unavailable');
  expect(other.provisioner.setDisplayName).not.toHaveBeenCalled();
  resume();
  expect(await first).toBe('ok');
  expect(await renameAgent(other, ownerId, matrixUserId, 'Writer')).toBe('ok');
  expect(await f.label()).toBe('Writer');
  expect(await f.store.read(nameKey('Reviewer'))).toEqual({ kind: 'absent' });
});
it('refuses side effects when storage work consumes the rename lease budget', async () => {
  const f = await fixture(); let now = f.clock();
  const deps = { ...f, clock: () => now };
  const write = f.store.compareAndSet;
  vi.spyOn(f.store, 'compareAndSet').mockImplementation(async (input, options) => {
    const result = await write(input, options);
    if (input.key.startsWith('agent-rename-lease/')) now += 300_000;
    return result;
  });
  expect(await renameAgent(deps, ownerId, matrixUserId, 'Reviewer')).toBe('unavailable');
  expect(f.provisioner.setDisplayName).not.toHaveBeenCalled();
  expect(await f.label()).toBe('Kevin-Claude');
});

it('replays failed old-name release on an identical-name retry', async () => {
  const f = await fixture(); const write = f.store.compareAndSet;
  const fault = vi.spyOn(f.store, 'compareAndSet').mockImplementation((input, options) =>
    input.key === nameKey('Kevin-Claude') && input.next.expiresAt !== null
      ? Promise.resolve({ kind: 'unavailable' }) : write(input, options));
  expect(await renameAgent(f, ownerId, matrixUserId, 'Reviewer')).toBe('unavailable');
  expect(await f.label()).toBe('Reviewer');
  expect((await f.store.read(nameKey('Kevin-Claude'))).kind).toBe('record');
  fault.mockImplementation(write);
  expect(await renameAgent(f, ownerId, matrixUserId, 'Reviewer')).toBe('ok');
  expect(await f.store.read(nameKey('Kevin-Claude'))).toEqual({ kind: 'absent' });
  expect(f.provisioner.setDisplayName).toHaveBeenCalledTimes(1);
});

it('reconciles a newer username committed while the earlier cascade is in flight', async () => {
  const f = await fixture();
  await f.put('profiles/owner', { v: 1, ownerId, username: 'Kev', updatedAt: new Date(f.clock()).toISOString() });
  f.provisioner.setDisplayName.mockImplementationOnce(async () => {
    await f.put('profiles/owner', { v: 1, ownerId, username: 'Kev2', updatedAt: new Date(f.clock()).toISOString() });
    return true;
  });
  await renameDefaultAgents(f, ownerId, 'Kevin', 'Kev');
  expect(await f.label()).toBe('Kev2-Claude');
  expect(await f.store.read(nameKey('Kevin-Claude'))).toEqual({ kind: 'absent' });
  expect(await f.store.read(nameKey('Kev-Claude'))).toEqual({ kind: 'absent' });
  expect(f.provisioner.setDisplayName).toHaveBeenLastCalledWith(matrixUserId, 'Kev2-Claude');
});
