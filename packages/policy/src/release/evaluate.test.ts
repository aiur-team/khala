import { describe, expect, it } from 'vitest';
import {
  type ApprovalCommand, type BindingId, type DeviceId, type ParticipantId, type RoomId, verifyReleasedJob,
} from '@khala/contracts/delivery/index';
import { evaluateApproval } from './index';
import { authority, binding, command, digest, id, record, scenario, text } from './fixtures/sample';

const decoded = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

describe('evaluateApproval', () => {
  it('releases exactly the two selected of three pending events to the named session generation', async () => {
    const { input, a, b } = await scenario();
    const result = await evaluateApproval(input);
    if (!result.ok) throw new Error(`rejected: ${result.reason}`);
    const { job, payload } = result.decision;

    expect(job.events).toEqual([a.ref, b.ref]);
    expect(job.binding).toEqual(binding());
    expect(job.approval).toEqual({ commandId: 'approve-1', policyVersion: 3, bindingGeneration: 0 });
    expect(verifyReleasedJob(job, input.command).ok).toBe(true);
    expect(decoded(payload)).toEqual([
      'khala.release.v1', 'release-1', 'bind-b-1', 0, 3,
      [
        ['room-1', 'event-a', 'agent-a', 'dev-a', a.ref.contentDigest, a.content.body],
        ['room-1', 'event-b', 'agent-a', 'dev-a', b.ref.contentDigest, b.content.body],
      ],
    ]);
    // The later arrival is neither released nor consumed.
    expect(new TextDecoder().decode(payload)).not.toContain('Arrived after review');
  });

  it('ignores a user-supplied human flag: only verified authority counts', async () => {
    const { input } = await scenario();
    const forged = { ...input.command, human: true } as unknown as ApprovalCommand;
    const result = await evaluateApproval({ ...input, command: forged, authority: authority('owner-mallory') });
    expect(result).toEqual({ ok: false, code: 'forbidden', reason: 'owner_mismatch', field: 'authority.ownerId' });
  });

  it.each([
    ['forged owner', { authority: authority('owner-mallory') }, 'forbidden', 'owner_mismatch'],
    ['wrong room', { room: { roomId: id<RoomId>('room-2'), members: [] } }, 'forbidden', 'room_mismatch'],
    ['recipient removed from room', { room: { roomId: id<RoomId>('room-1'), members: [id<ParticipantId>('agent-a')] } }, 'forbidden', 'recipient_not_member'],
    ['author removed from room', { room: { roomId: id<RoomId>('room-1'), members: [id<ParticipantId>('agent-b')] } }, 'forbidden', 'author_not_member'],
    ['stale expectedBindingGeneration', { binding: binding(1) }, 'stale_binding', 'stale_binding'],
    ['different binding', { binding: { ...binding(), bindingId: id<BindingId>('bind-b-2') } }, 'stale_binding', 'binding_mismatch'],
    ['policy mismatch', { policyVersion: 4 }, 'stale_policy', 'stale_policy'],
  ] as const)('rejects the whole selection for %s', async (_name, change, code, reason) => {
    const { input } = await scenario();
    const result = await evaluateApproval({ ...input, ...change });
    expect(result).toMatchObject({ ok: false, code, reason });
  });

  it('rejects the whole selection when one selected item is missing or redacted', async () => {
    const { input, a, c } = await scenario();
    const result = await evaluateApproval({ ...input, pending: [a, c] });
    expect(result).toEqual({ ok: false, code: 'expired_content', reason: 'missing_content', field: 'command.selection[1]' });
  });

  it('rejects an author device substitution', async () => {
    const { input, a, b, c } = await scenario();
    const substituted = { ...b, ref: { ...b.ref, authorDeviceId: id<DeviceId>('dev-mallory') } };
    const result = await evaluateApproval({ ...input, pending: [a, substituted, c] });
    expect(result).toMatchObject({ ok: false, code: 'stale_content', reason: 'content_mismatch', field: 'command.selection[1]' });
  });

  it('rejects a changed body that still carries the old digest', async () => {
    const { input, a, b, c } = await scenario();
    const edited = { ...b, content: text('Second point: turn the flag ON.') };
    const result = await evaluateApproval({ ...input, pending: [a, edited, c] });
    expect(result).toMatchObject({ ok: false, code: 'stale_content', reason: 'digest_mismatch' });
  });

  it('rejects an edit that arrived as a new digest for the selected event', async () => {
    const { input, a, c } = await scenario();
    const edited = await record('event-b', 'Second point: turn the flag ON.');
    const result = await evaluateApproval({ ...input, pending: [a, edited, c] });
    expect(result).toMatchObject({ ok: false, code: 'stale_content', reason: 'content_mismatch' });
  });

  it('rejects an ambiguous snapshot holding two records for one selected event', async () => {
    const { input, a, b } = await scenario();
    const result = await evaluateApproval({ ...input, pending: [a, b, b] });
    expect(result).toMatchObject({ ok: false, code: 'stale_content', reason: 'content_mismatch' });
  });

  it('rejects duplicate or cross-room selections instead of choosing an interpretation', async () => {
    const { input, a } = await scenario();
    const duplicate = await evaluateApproval({ ...input, command: command([a.ref, a.ref]) });
    expect(duplicate).toMatchObject({ ok: false, code: 'forbidden', reason: 'invalid_selection', field: 'command.selection[1]' });
    const crossRoom = await evaluateApproval({
      ...input,
      command: command([a.ref, { ...a.ref, roomId: id<RoomId>('room-2'), eventId: id('event-x') }]),
    });
    expect(crossRoom).toMatchObject({ ok: false, code: 'forbidden', reason: 'invalid_selection' });
    const empty = await evaluateApproval({ ...input, command: command([]) });
    expect(empty).toMatchObject({ ok: false, code: 'forbidden', reason: 'invalid_selection' });
  });

  it('rejects unknown message content versions', async () => {
    const { input, a, b } = await scenario();
    const future = { ...b, content: { ...b.content, v: 2 } } as unknown as typeof b;
    const result = await evaluateApproval({ ...input, pending: [a, future] });
    expect(result).toMatchObject({ ok: false, code: 'stale_content', reason: 'unsupported_content' });
  });

  it('checks authority before touching pending content', async () => {
    const { input } = await scenario();
    const pending = new Proxy([], { get: () => { throw new Error('pending read'); } });
    const result = await evaluateApproval({ ...input, authority: authority('owner-mallory'), pending });
    expect(result).toMatchObject({ ok: false, reason: 'owner_mismatch' });
  });

  it('does not treat issuedAt as freshness or authority', async () => {
    const { input } = await scenario();
    const old = await evaluateApproval({ ...input, command: { ...input.command, issuedAt: '1970-01-01T00:00:00Z' } });
    expect(old.ok).toBe(true);
  });

  it('matches the KHA-105 content digest for a non-ASCII body', async () => {
    const { input } = await scenario();
    const body = 'Café\r\nline — “quoted” \u2028 \u0001 🚀';
    const item = await record('event-u', body);
    expect(item.ref.contentDigest).toBe(await digest(body));
    const result = await evaluateApproval({ ...input, command: command([item.ref]), pending: [item] });
    expect(result.ok).toBe(true);
  });
});
