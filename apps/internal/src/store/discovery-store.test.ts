import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import { afterEach, describe, expect, it } from 'vitest';
import { createChannelStore } from './channel-store';
import { type DiscoveryStore, createDiscoveryStore } from './discovery-store';
import { type InternalStoreHandle, openChannelStore } from './open';

const roots: string[] = [];
const handles: InternalStoreHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const owner = 'owner_1' as OwnerId;
const human = 'participant_human' as ParticipantId;
const humanDevice = 'device_human' as DeviceId;
const T = '2026-09-25T12:00:00.000Z';

function directory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-discovery-store-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  return path.join(root, 'state');
}

function open(target: string, mode: 'create' | 'existing' = 'create'): Readonly<{ handle: InternalStoreHandle; discovery: DiscoveryStore }> {
  const handle = openChannelStore({ directory: target, mode });
  handles.push(handle);
  return { handle, discovery: createDiscoveryStore(handle) };
}

function seed(handle: InternalStoreHandle, channels: ReadonlyArray<readonly [string, string | null]>): void {
  const store = createChannelStore(handle);
  store.registerParticipant({ participantId: human, ownerId: owner, kind: 'human', displayName: 'Owner' });
  store.registerDevice({ deviceId: humanDevice, participantId: human });
  for (const [channelId, title] of channels) {
    expect(store.createChannel({
      operationId: `create_${channelId}`, channelId: channelId as RoomId, title, creatorOwnerId: owner,
      creatorParticipantId: human, creatorDeviceId: humanDevice, createdAt: T,
    }).kind).toBe('created');
  }
}

function issue(discovery: DiscoveryStore, principal: string, capability = `cap_${principal}`) {
  const issued = discovery.issueAgent({
    principal, harness: 'codex', sessionDigest: `session_${principal}`, displayLabel: null, workspaceLabel: null,
    capabilityDigest: capability, proofPublicKey: `pk_${capability}`, proofThumbprint: `jkt_${capability}`, issuedAt: T,
  });
  if (issued.kind !== 'issued') throw new Error('issue failed');
  return issued.agent;
}

function set(discovery: DiscoveryStore, channelId: string, operationId: string, change: Parameters<DiscoveryStore['updateSettings']>[0]['change']) {
  const current = discovery.settings(channelId);
  if (current.kind !== 'done') throw new Error('settings missing');
  return discovery.updateSettings({ channelId, operationId, expectedRevision: current.settings.revision, change });
}

const listed = (discovery: DiscoveryStore, principal: string) => {
  const result = discovery.eligibleChannels(principal);
  if (result.kind !== 'done') throw new Error('unavailable');
  return result.channels.map(channel => channel.channelId);
};

describe('internal discovery store', () => {
  it('defaults to private with no allowlist, lists per-principal, and never lists secret channels', () => {
    const { handle, discovery } = open(directory());
    seed(handle, [['ch_a', 'Alpha'], ['ch_b', 'Beta'], ['ch_c', null]]);
    const first = issue(discovery, 'agent_1');
    const second = issue(discovery, 'agent_2');
    expect(discovery.settings('ch_a')).toEqual({
      kind: 'done', settings: { channelId: 'ch_a', visibility: 'private', visibilityEpoch: 0, revision: 0, allowlist: [] },
    });
    expect(listed(discovery, first.principal)).toEqual([]);
    expect(set(discovery, 'ch_a', 'op1', { kind: 'allow', principal: first.principal, expectedGeneration: 1 }).kind).toBe('done');
    expect(set(discovery, 'ch_b', 'op2', { kind: 'allow', principal: second.principal, expectedGeneration: 1 }).kind).toBe('done');
    expect(set(discovery, 'ch_c', 'op3', { kind: 'visibility', visibility: 'public' }).kind).toBe('done');
    // Two agents of the same local owner see different private listings.
    expect(listed(discovery, first.principal)).toEqual(['ch_c', 'ch_a']);
    expect(listed(discovery, second.principal)).toEqual(['ch_c', 'ch_b']);
    expect(set(discovery, 'ch_a', 'op4', { kind: 'visibility', visibility: 'secret' }).kind).toBe('done');
    // Secret hides the channel even from an allowlisted principal.
    expect(listed(discovery, first.principal)).toEqual(['ch_c']);
    expect(discovery.eligible('ch_a', first.principal)).toBe(false);
    expect(discovery.target('ch_a')).toEqual({ kind: 'found', target: { channelId: 'ch_a', title: 'Alpha', visibility: 'secret', visibilityEpoch: 1 } });
  });

  it('checks revisions, replays operations, and refuses unknown or rotated principals', () => {
    const { handle, discovery } = open(directory());
    seed(handle, [['ch_a', 'Alpha']]);
    const agent = issue(discovery, 'agent_1');
    const applied = discovery.updateSettings({ channelId: 'ch_a', operationId: 'op1', expectedRevision: 0, change: { kind: 'visibility', visibility: 'public' } });
    expect(applied).toMatchObject({ kind: 'done', settings: { visibility: 'public', visibilityEpoch: 1, revision: 1 } });
    expect(discovery.updateSettings({ channelId: 'ch_a', operationId: 'op1', expectedRevision: 0, change: { kind: 'visibility', visibility: 'public' } }))
      .toEqual(applied);
    expect(discovery.updateSettings({ channelId: 'ch_a', operationId: 'op1', expectedRevision: 0, change: { kind: 'visibility', visibility: 'secret' } }))
      .toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(discovery.updateSettings({ channelId: 'ch_a', operationId: 'op2', expectedRevision: 0, change: { kind: 'visibility', visibility: 'secret' } }))
      .toEqual({ kind: 'rejected', code: 'stale_revision' });
    expect(set(discovery, 'ch_a', 'op3', { kind: 'allow', principal: 'agent_unknown', expectedGeneration: 1 }))
      .toEqual({ kind: 'rejected', code: 'unknown_principal' });
    issue(discovery, agent.principal, 'cap_rotated');
    expect(set(discovery, 'ch_a', 'op4', { kind: 'allow', principal: agent.principal, expectedGeneration: 1 }))
      .toEqual({ kind: 'rejected', code: 'wrong_generation' });
    expect(discovery.updateSettings({ channelId: 'ch_missing', operationId: 'op5', expectedRevision: 0, change: { kind: 'visibility', visibility: 'public' } }))
      .toEqual({ kind: 'rejected', code: 'not_found' });
  });

  it('rotates a reissued principal to the next generation and a new capability digest', () => {
    const { discovery } = open(directory());
    const first = issue(discovery, 'agent_1', 'cap_a');
    const second = issue(discovery, 'agent_1', 'cap_b');
    expect([first.generation, second.generation]).toEqual([1, 2]);
    expect(discovery.agentByCapability('cap_a')).toEqual({ kind: 'absent' });
    expect(discovery.agentByCapability('cap_b')).toEqual({ kind: 'found', agent: second });
    // A principal is bound to one harness session.
    expect(discovery.issueAgent({ ...second, sessionDigest: 'other', capabilityDigest: 'cap_c' })).toEqual({ kind: 'rejected' });
  });

  it('keeps visibility, allowlists and agents across restart', () => {
    const target = directory();
    const first = open(target);
    seed(first.handle, [['ch_a', 'Alpha']]);
    const agent = issue(first.discovery, 'agent_1');
    set(first.discovery, 'ch_a', 'op1', { kind: 'allow', principal: agent.principal, expectedGeneration: 1 });
    first.handle.close();
    const { discovery } = open(target, 'existing');
    expect(listed(discovery, agent.principal)).toEqual(['ch_a']);
    expect(discovery.agentByCapability('cap_agent_1')).toEqual({ kind: 'found', agent });
  });

  it('admits idempotently per provider operation without creating a binding', () => {
    const { handle, discovery } = open(directory());
    seed(handle, [['ch_a', 'Alpha']]);
    const input = {
      providerOperationId: 'padmit_1', channelId: 'ch_a', ownerId: owner, participantId: 'participant_agent' as ParticipantId,
      deviceId: 'device_agent' as DeviceId, displayName: 'codex',
    };
    expect(discovery.reconcileAdmission(input)).toEqual({ kind: 'not_applied' });
    expect(discovery.admit(input)).toEqual({ kind: 'admitted', membership: 'joined' });
    expect(discovery.admit(input)).toEqual({ kind: 'admitted', membership: 'joined' });
    expect(discovery.reconcileAdmission(input)).toEqual({ kind: 'admitted', membership: 'joined' });
    expect(discovery.admit({ ...input, providerOperationId: 'padmit_2' })).toEqual({ kind: 'admitted', membership: 'already_joined' });
    expect(discovery.admit({ ...input, deviceId: 'device_other' as DeviceId })).toEqual({ kind: 'rejected' });
    expect(discovery.admit({ ...input, providerOperationId: 'padmit_3', channelId: 'ch_missing' })).toEqual({ kind: 'rejected' });
    expect(handle.read(db => db.prepare('SELECT count(*) AS n FROM bindings').get())).toEqual({ n: 0 });
    expect(createChannelStore(handle).channel({ channelId: 'ch_a' as RoomId, participantId: input.participantId }).kind).toBe('done');
  });

  it('creates or reconciles exactly one secret channel per idempotency key and no agent membership', () => {
    const target = directory();
    const first = open(target);
    seed(first.handle, []);
    const input = {
      idempotencyKey: 'intent_1', channelId: 'ch_new', title: 'Proposed', ownerId: owner,
      creatorParticipantId: human, creatorDeviceId: humanDevice, createdAt: T,
    };
    expect(first.discovery.findSecretChannel('intent_1')).toEqual({ kind: 'absent' });
    expect(first.discovery.createSecretChannel(input)).toEqual({ kind: 'created', channelId: 'ch_new' });
    first.handle.close();
    const { handle, discovery } = open(target, 'existing');
    expect(discovery.createSecretChannel({ ...input, channelId: 'ch_other' })).toEqual({ kind: 'already_created', channelId: 'ch_new' });
    expect(discovery.findSecretChannel('intent_1')).toEqual({ kind: 'already_created', channelId: 'ch_new' });
    expect(discovery.createSecretChannel({ ...input, title: 'Changed' })).toEqual({ kind: 'operation_mismatch' });
    expect(discovery.settings('ch_new')).toMatchObject({ kind: 'done', settings: { visibility: 'secret' } });
    expect(handle.read(db => db.prepare('SELECT count(*) AS n FROM channels').get())).toEqual({ n: 1 });
    expect(handle.read(db => db.prepare('SELECT participant_id FROM memberships').all())).toEqual([{ participant_id: human }]);
    expect(handle.read(db => db.prepare('SELECT count(*) AS n FROM bindings').get())).toEqual({ n: 0 });
  });
});
