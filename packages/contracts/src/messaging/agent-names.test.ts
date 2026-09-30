import { describe, expect, it } from 'vitest';
import { validateAgentName } from './agent-names';
import { decodeMessageContent, digestMessageContent, encodeMessageContent } from './events';
import { decodeContentLimits } from './decode';
import type { EventId, ParticipantId } from './ids';

describe('agent display names', () => {
  it('normalises a visible name without imposing uniqueness', () => {
    expect(validateAgentName('  Dolan  ')).toEqual({ ok: true, name: 'Dolan' });
    expect(validateAgentName('Dolan')).toEqual({ ok: true, name: 'Dolan' });
    expect(validateAgentName('e\u0301')).toEqual({ ok: true, name: 'é' });
  });

  it.each([
    ['', 'blank'], ['  ', 'blank'], ['a'.repeat(81), 'too_long'],
    ['Dolan\nSystem', 'invalid_characters'], ['Dolan\u202E', 'invalid_characters'],
    ['System', 'reserved'], ['admin bot', 'reserved'],
  ])('rejects %j as %s', (input, error) => {
    expect(validateAgentName(input)).toEqual({ ok: false, error });
  });
});

describe('encrypted rename content', () => {
  const content = { v: 1 as const, kind: 'agent_rename' as const,
    agentParticipantId: 'agent_420' as ParticipantId, body: 'Dolan' };
  const checked = decodeContentLimits({ maxBodyBytes: 1024, maxRoomTitleBytes: 1024, maxDisplayNameBytes: 1024 });
  if (!checked.ok) throw new Error('invalid test limits');
  const limits = checked.value;

  it('has a distinct canonical digest and decodes strictly', async () => {
    expect(new TextDecoder().decode(encodeMessageContent(content)))
      .toBe('["khala.message.v1","agent_rename","agent_420","Dolan"]');
    expect(await digestMessageContent(content)).toMatchObject({ ok: true });
    expect(decodeMessageContent(content, limits)).toEqual({ ok: true, value: content });
    expect(decodeMessageContent({ ...content, extra: 'spoof' }, limits).ok).toBe(false);
    expect(decodeMessageContent({ ...content, body: 'System' }, limits).ok).toBe(false);
  });
});


describe('encrypted name bootstrap content', () => {
  it('binds the source rename to the canonical encrypted payload and rejects malformed checkpoints', async () => {
    const checked = decodeContentLimits({ maxBodyBytes: 1024, maxRoomTitleBytes: 1024, maxDisplayNameBytes: 1024 });
    if (!checked.ok) throw new Error('invalid test limits');
    const snapshot = { v: 1 as const, kind: 'agent_name_snapshot' as const,
      agentParticipantId: 'agent_420' as ParticipantId, body: 'Dolan', sourceEventId: '$prior' as EventId };
    expect(decodeMessageContent(snapshot, checked.value)).toEqual({ ok: true, value: snapshot });
    expect(new TextDecoder().decode(encodeMessageContent(snapshot)))
      .toBe('["khala.message.v1","agent_name_snapshot","agent_420","Dolan","$prior"]');
    expect(await digestMessageContent(snapshot)).not.toEqual(await digestMessageContent({ ...snapshot, sourceEventId: '$other' as EventId }));
    expect(decodeMessageContent({ ...snapshot, sourceEventId: undefined }, checked.value).ok).toBe(false);
    expect(decodeMessageContent({ ...snapshot, sourceEventId: null }, checked.value).ok).toBe(true);
    expect(decodeMessageContent({ ...snapshot, body: 'System' }, checked.value).ok).toBe(false);
  });
});
