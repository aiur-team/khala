import { describe, expect, it } from 'vitest';
import codexColor from './assets/codex-color.svg';
import claudeSymbol from './assets/claude-symbol.svg';
import geminiLogo from './assets/gemini.svg';
import { HARNESS_REGISTRY } from '@khala/contracts/m1/harness';
import { AGENT_HUES, HUMAN_HUES, fnv1a, harnessDisplayName, harnessLogo, humanInitials, initials, ownerInitials, participantHue } from './identity';

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
    expect(harnessLogo('cline')).toBeNull();
  });
});

describe('ownerInitials', () => {
  const humans = [{ ownerId: 'owner_kai', displayName: 'Kai Watanabe' }, { displayName: 'Maya Chen' }];

  it('uses the owner full name, found by owner id or first name', () => {
    expect(ownerInitials({ ownerId: 'owner_kai', label: 'Kai' }, humans)).toBe('KW');
    expect(ownerInitials({ label: 'Maya' }, humans)).toBe('MC');
  });

  it('falls back to the label for an owner not on screen', () => {
    expect(ownerInitials({ ownerId: 'owner_bob', label: 'Bob' }, humans)).toBe('BO');
  });

  it('prefers the chosen initials, then the matched owner\'s, then derivation', () => {
    const chosen = [{ ownerId: 'owner_kai', displayName: 'Kai Watanabe', initials: 'ZZ' }, { displayName: 'Maya Chen', initials: null }];
    expect(ownerInitials({ ownerId: 'owner_kai', label: 'Kai', chosen: 'QQ' }, chosen)).toBe('QQ');
    expect(ownerInitials({ ownerId: 'owner_kai', label: 'Kai' }, chosen)).toBe('ZZ');
    expect(ownerInitials({ label: 'Kai' }, chosen)).toBe('ZZ');
    expect(ownerInitials({ label: 'Maya', chosen: null }, chosen)).toBe('MC');
  });
});

describe('humanInitials', () => {
  it('shows chosen initials, else derives them from the name', () => {
    expect(humanInitials('Kai Watanabe', 'ZZ')).toBe('ZZ');
    expect(humanInitials('Kai Watanabe', null)).toBe('KW');
    expect(humanInitials('Kai Watanabe')).toBe('KW');
  });
});

describe('registry logo coverage', () => {
  it('uses the Gemini asset and falls back for unregistered ids', () => {
    expect(harnessLogo('gemini')).toBe(geminiLogo);
    expect(harnessLogo('claude-code')).toBeNull();
    expect(harnessLogo('constructor')).toBeNull();
  });
  it.each(HARNESS_REGISTRY.filter(info => info.logoKey !== null))('resolves $id via its registry key', info => {
    expect(harnessLogo(info.id)).not.toBeNull();
  });
  it('uses the same Copilot mark for both clients', () => {
    expect(harnessLogo('vscode')).toBe(harnessLogo('copilot'));
  });
});

describe('registered harnesses without redistributable marks', () => {
  it.each([['antigravity', 'Antigravity CLI'], ['muse', 'Muse Code']])('preserves %s identity without a logo', (id, name) => {
    expect(harnessLogo(id)).toBeNull();
    expect(harnessDisplayName(id)).toBe(name);
  });
});
