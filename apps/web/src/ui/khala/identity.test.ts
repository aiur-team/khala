import { describe, expect, it } from 'vitest';
import codexColor from './assets/codex-color.svg';
import claudeSymbol from './assets/claude-symbol.svg';
import { AGENT_HUES, HUMAN_HUES, fnv1a, harnessLogo, initials, participantHue } from './identity';

describe('participantHue', () => {
  it('gives the viewer 214', () => {
    expect(participantHue({ kind: 'human', ownerId: 'owner_me', isViewer: true })).toBe(214);
  });

  it('keeps one hue per human owner, from the human palette', () => {
    const first = participantHue({ kind: 'human', ownerId: 'owner_maya' });
    expect(participantHue({ kind: 'human', ownerId: 'owner_maya', participantId: 'p_other_device' })).toBe(first);
    expect(HUMAN_HUES).toContain(first);
    expect(first).toBe(HUMAN_HUES[fnv1a('owner_maya') % 8]);
  });

  it('puts every agent on one of the four design hues', () => {
    for (const participantId of ['p_1', 'p_2', 'p_3', 'agent_claude', 'agent_codex', 'ü']) {
      const hue = participantHue({ kind: 'agent', participantId });
      expect([210, 150, 265, 32]).toContain(hue);
      expect(hue).toBe(AGENT_HUES[fnv1a(participantId) % 4]);
    }
  });

  it('lets an override keyed by participant id win', () => {
    const overrides = new Map([['p_kai', 150]]);
    expect(participantHue({ kind: 'human', ownerId: 'owner_kai', participantId: 'p_kai' }, overrides)).toBe(150);
    expect(participantHue({ kind: 'agent', participantId: 'p_kai' }, overrides)).toBe(150);
  });

  it('hashes with 32-bit FNV-1a', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
  });
});

describe('initials', () => {
  it.each([
    ['Maya Chen', 'MC'],
    ['kai.watanabe', 'KW'],
    ['Kevin', 'KE'],
    ['You', 'YO'],
    ['maya@example.com', 'MA'],
    ['', '?'],
  ])('%s → %s', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});

describe('harnessLogo', () => {
  it('returns the bundled logo for known harnesses and null otherwise', () => {
    expect(harnessLogo('codex')).toBe(codexColor);
    expect(harnessLogo('claude')).toBe(claudeSymbol);
    expect(harnessLogo('gemini')).toBeNull();
  });
});
