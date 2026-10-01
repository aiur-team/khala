// AC5 remains open until both native sessions have a shared, proven mode.
// A Claude installation version is not proof for the session under test.

import { describe, expect, it } from 'vitest';
import { openCodeDeepSeekClaudeDocument, openCodeDeepSeekClaudeProfile } from '../../../scripts/acceptance/profiles/opencode-deepseek-claude';

const input = () => ({
  khalaPackage: '@aiur/khala@0.4.0', openCodeModel: 'deepseek/deepseek-flash', claudeModel: 'opus',
});

describe('AC5 OpenCode DeepSeek and Claude profile', () => {
  it('keeps live AC5 acceptance blocked without shared proven same-session mode proof', () => {
    expect(() => openCodeDeepSeekClaudeProfile(input())).toThrow('AC5 profile: no shared proven mode');
    expect(() => openCodeDeepSeekClaudeDocument(input())).toThrow('AC5 profile: no shared proven mode');
  });

  it('refuses direct DeepSeek, a second OpenCode agent, and unpinned builds at profile creation', () => {
    expect(() => openCodeDeepSeekClaudeProfile({
      ...input(), openCodeModel: 'deepseek-direct',
    })).toThrow(/DeepSeek provider model/);
    expect(() => openCodeDeepSeekClaudeProfile({
      ...input(), claudeModel: 'deepseek/deepseek-flash',
    })).toThrow(/Claude model/);
    expect(() => openCodeDeepSeekClaudeProfile({
      ...input(), khalaPackage: '@aiur/khala@latest',
    })).toThrow(/khalaPackage/);
  });
});
