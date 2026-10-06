import { describe, expect, it } from 'vitest';
import {
  channelNameSuggestion, decodeChannelNameResult, freeAgentName, isSuffixedAgentName, localChannelNamePath, nameCollisions,
} from './channel-names';

describe('channelNameSuggestion', () => {
  it('suggests the name plus the lowest free number', () => {
    expect(channelNameSuggestion('alice', 'username', ['alice'])).toBe('alice2');
    expect(channelNameSuggestion('alice', 'username', ['alice', 'alice2'])).toBe('alice3');
  });
  it('fills gaps first and compares case-insensitively', () => {
    expect(channelNameSuggestion('alice', 'username', ['Alice', 'ALICE3'])).toBe('alice2');
    expect(channelNameSuggestion('alice', 'username', ['alice', 'alice2', 'alice4'])).toBe('alice3');
  });
  it('counts on from the stem of a name that already ends in a number', () => {
    expect(channelNameSuggestion('alice2', 'username', ['alice2'])).toBe('alice3');
    expect(channelNameSuggestion('alice2', 'username', ['alice2', 'alice3'])).toBe('alice4');
  });
  it('stays a valid username at the length limit', () => {
    const long = 'a'.repeat(24);
    const suggestion = channelNameSuggestion(long, 'username', [long]);
    expect(suggestion).toBe(`${'a'.repeat(23)}2`);
  });
  it('keeps the dash form for agents', () => {
    expect(channelNameSuggestion('kevin-Claude', 'agent', ['kevin-Claude'])).toBe('kevin-Claude-2');
    expect(channelNameSuggestion('kevin-Claude-2', 'agent', ['kevin-Claude', 'kevin-Claude-2'])).toBe('kevin-Claude-3');
    expect(channelNameSuggestion('reviewer', 'agent', ['reviewer', 'reviewer-2'])).toBe('reviewer-3');
  });
});

it('picks the lowest free default agent name in a channel', () => {
  expect(freeAgentName('kevin', 'claude', [])).toBe('kevin-Claude');
  expect(freeAgentName('kevin', 'gemini', [' kevin-gemini '])).toBe('kevin-Gemini-2');
  expect(freeAgentName('kevin', 'custom-harness', [])).toBe('kevin-Agent');
  expect(freeAgentName('kevin', 'claude', ['kevin-claude'])).toBe('kevin-Claude-2');
  expect(freeAgentName('kevin', 'claude', ['kevin-Claude', 'kevin-Claude-3'])).toBe('kevin-Claude-2');
});

describe('nameCollisions', () => {
  it('lists only the later holder of a shared name', () => {
    const collisions = nameCollisions([
      { id: 'b', name: 'alice', since: 20 }, { id: 'a', name: 'Alice', since: 10 }, { id: 'c', name: 'carol', since: 5 },
    ]);
    expect([...collisions]).toEqual([['b', 'a']]);
  });
  it('maps every later holder to the first one', () => {
    const collisions = nameCollisions([{ id: 'a', name: 'x1', since: 1 }, { id: 'b', name: 'x1', since: 2 }, { id: 'c', name: 'x1', since: 3 }]);
    expect(Object.fromEntries(collisions)).toEqual({ b: 'a', c: 'a' });
  });
  it('orders members without a time after those with one, then by list order', () => {
    expect([...nameCollisions([{ id: 'a', name: 'bob' }, { id: 'b', name: 'bob', since: 99 }])]).toEqual([['a', 'b']]);
    expect([...nameCollisions([{ id: 'a', name: 'bob' }, { id: 'b', name: 'bob' }])]).toEqual([['b', 'a']]);
  });
});

it('recognises an automatic agent suffix on a name someone else holds', () => {
  expect(isSuffixedAgentName('kevin-Claude-2', ['kevin-Claude'])).toBe(true);
  expect(isSuffixedAgentName('kevin-Claude-3', ['kevin-claude-2'])).toBe(true);
  expect(isSuffixedAgentName('kevin-Claude-2', ['bob'])).toBe(false);
  expect(isSuffixedAgentName('kevin-Claude', ['kevin-Claude'])).toBe(false);
});

it('decodes the local channel-name result', () => {
  expect(localChannelNamePath('!a:local')).toBe('/api/local/channels/!a%3Alocal/name');
  expect(decodeChannelNameResult({ name: 'alice2' })).toEqual({ ok: true, value: { name: 'alice2' } });
  expect(decodeChannelNameResult({ name: 'alice2', extra: 1 }).ok).toBe(false);
  expect(decodeChannelNameResult({ name: 'a b' }).ok).toBe(false);
});
