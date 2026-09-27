import { describe, expect, it } from 'vitest';
import { codexHookCommand, codexHookReviewState, codexHooksFragment } from './hooks-config.js';

const HOOKS_PATH = '/home/user/.codex/hooks.json';
const LAUNCHER = '/home/user/.local/share/khala/bin/khala';
const COMMAND = codexHookCommand(LAUNCHER);
const EVENTS = ['pre_tool_use', 'post_tool_use', 'user_prompt_submit', 'stop'];
const hash = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

function trust(keys: readonly string[]): string {
  return keys.map((key, index) => `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "${hash(String(index % 10))}"\n`)
    .join('\n');
}

describe('codex hooks fragment', () => {
  it('installs one fixed handler, the staged launcher by absolute path, for each Khala boundary', () => {
    const handler = { type: 'command', command: "'/home/user/.local/share/khala/bin/khala' codex-hook", timeout: 30 };
    expect(codexHooksFragment(LAUNCHER)).toEqual({
      hooks: {
        PreToolUse: [{ hooks: [handler] }],
        PostToolUse: [{ hooks: [handler] }],
        UserPromptSubmit: [{ hooks: [handler] }],
        Stop: [{ hooks: [handler] }],
      },
    });
    // Byte-stable: a change here invalidates every user's hook trust. The launcher path never
    // moves, and a bare `khala` would depend on the person's PATH.
    expect(COMMAND).toBe("'/home/user/.local/share/khala/bin/khala' codex-hook");
    expect(codexHookCommand("/home/o'neil/khala")).toBe("'/home/o'\\''neil/khala' codex-hook");
    expect(() => codexHookCommand('khala')).toThrow();
  });
});

describe('codex hook review state', () => {
  it('is trusted only when Codex recorded trust for every installed Khala handler', () => {
    const configToml = [
      '[projects."/home/user/work"]\ntrust_level = "trusted"\n',
      trust(EVENTS.map(event => `${HOOKS_PATH}:${event}:0:0`)),
    ].join('\n');
    expect(codexHookReviewState({ launcher: LAUNCHER, hooksPath: HOOKS_PATH, hooksJson: codexHooksFragment(LAUNCHER), configToml }))
      .toEqual({ state: 'trusted' });
  });

  it('awaits review while any handler has no trust record', () => {
    const configToml = trust(EVENTS.filter(event => event !== 'stop').map(event => `${HOOKS_PATH}:${event}:0:0`));
    expect(codexHookReviewState({ launcher: LAUNCHER, hooksPath: HOOKS_PATH, hooksJson: codexHooksFragment(LAUNCHER), configToml })).toEqual({
      state: 'awaiting_hook_review',
      reason: expect.stringContaining('Stop'),
    });
    expect(codexHookReviewState({ launcher: LAUNCHER, hooksPath: HOOKS_PATH, hooksJson: codexHooksFragment(LAUNCHER), configToml: null }))
      .toMatchObject({ state: 'awaiting_hook_review' });
  });

  it("matches trust at the handler position Codex hashes, after the user's own hooks", () => {
    const own = { type: 'command', command: '/usr/local/bin/audit' };
    const khala = { type: 'command', command: COMMAND, timeout: 30 };
    const hooksJson = { hooks: {
      PreToolUse: [{ hooks: [own] }, { hooks: [own, khala] }],
      PostToolUse: [{ hooks: [khala] }],
      UserPromptSubmit: [{ hooks: [khala] }],
      Stop: [{ hooks: [khala] }],
    } };
    const others = EVENTS.slice(1).map(event => `${HOOKS_PATH}:${event}:0:0`);
    expect(codexHookReviewState({ launcher: LAUNCHER,
      hooksPath: HOOKS_PATH, hooksJson, configToml: trust([`${HOOKS_PATH}:pre_tool_use:0:0`, ...others]),
    })).toMatchObject({ state: 'awaiting_hook_review', reason: expect.stringContaining('PreToolUse') });
    expect(codexHookReviewState({ launcher: LAUNCHER,
      hooksPath: HOOKS_PATH, hooksJson, configToml: trust([`${HOOKS_PATH}:pre_tool_use:1:1`, ...others]),
    })).toEqual({ state: 'trusted' });
  });

  it('ignores trust records outside hooks.state tables and without a hash', () => {
    const key = (event: string) => `${HOOKS_PATH}:${event}:0:0`;
    const configToml = [
      ...EVENTS.slice(0, 3).map(event => `[hooks.state.${JSON.stringify(key(event))}]\ntrusted_hash = "${hash('a')}"`),
      `[hooks.state.${JSON.stringify(key('stop'))}]`,
      `[other]\ntrusted_hash = "${hash('b')}"`,
    ].join('\n');
    expect(codexHookReviewState({ launcher: LAUNCHER, hooksPath: HOOKS_PATH, hooksJson: codexHooksFragment(LAUNCHER), configToml }))
      .toMatchObject({ state: 'awaiting_hook_review' });
  });

  it('reports unknown with a reason when the hooks are missing or unreadable', () => {
    expect(codexHookReviewState({ launcher: LAUNCHER, hooksPath: HOOKS_PATH, hooksJson: { hooks: {} }, configToml: '' }))
      .toEqual({ state: 'unknown', reason: expect.stringContaining('not installed') });
    expect(codexHookReviewState({ launcher: LAUNCHER, hooksPath: HOOKS_PATH, hooksJson: { hooks: { Stop: 'x' } }, configToml: '' }))
      .toMatchObject({ state: 'unknown' });
    expect(codexHookReviewState({ launcher: LAUNCHER, hooksPath: 'hooks.json', hooksJson: codexHooksFragment(LAUNCHER), configToml: '' }))
      .toMatchObject({ state: 'unknown' });
  });
});
