import { describe, expect, it } from 'vitest';
import { validateAgentName } from './agent-names';
import { decodeMessageContent, digestMessageContent, encodeMessageContent } from './events';
import { decodeContentLimits } from './decode';
import type { ParticipantId } from './ids';

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
