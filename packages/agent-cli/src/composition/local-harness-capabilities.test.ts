import { describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { codexHooksFragment } from '../codex/hooks-config.js';
import type { SetupEnvironment } from '../setup/types.js';
import { localHarnessCapabilities } from './local-harness-capabilities.js';

const CODEX_HOME = '/home/user/.codex';
const HOOKS_PATH = `${CODEX_HOME}/hooks.json`;
const TRUST = ['pre_tool_use', 'post_tool_use', 'user_prompt_submit', 'stop']
  .map(event => `[hooks.state.${JSON.stringify(`${HOOKS_PATH}:${event}:0:0`)}]\ntrusted_hash = "sha256:${'a'.repeat(64)}"\n`)
  .join('\n');

const binding = (harness: string) => ({ harness } as SessionBinding);

function environment(input: Readonly<{ version?: string | null; config?: string | null; runs?: string[] }>): SetupEnvironment {
  const files: Record<string, string | null> = {
    [HOOKS_PATH]: JSON.stringify(codexHooksFragment('/home/user/.local/share/khala/bin/khala')),
    [`${CODEX_HOME}/config.toml`]: input.config ?? null,
  };
  return {
    home: '/home/user', xdgConfigHome: '/home/user/.config', xdgDataHome: '/home/user/.local/share',
    xdgStateHome: '/home/user/.local/state', codexHome: CODEX_HOME,
    probe: {
      resolveExecutable: async name => (name === 'codex' && input.version !== null ? '/usr/bin/codex' : null),
      runVersion: async (executable, args) => {
        input.runs?.push([executable, ...args].join(' '));
        return `codex-cli ${input.version ?? '0.156.1'}\n`;
      },
      readFile: async file => (files[file] === null || files[file] === undefined ? null : new TextEncoder().encode(files[file]!)),
      listDirectory: async () => null,
    },
  } as SetupEnvironment;
}

describe('local harness capabilities', () => {
  it('claims the Codex hook route for a proven version whose Khala hooks the user trusted', async () => {
    const runs: string[] = [];
    const claim = localHarnessCapabilities(() => environment({ config: TRUST, runs }));
    const codex = await claim(binding('codex'));
    expect(codex).toMatchObject({ harness: 'codex', version: '0.156.1', support: 'tested', acknowledgement: 'unknown' });
    expect(codex!.modes.sync.status).toBe('proven');
    // No receipt proof is shipped, so async stays unproven.
    expect(codex!.modes.async.status).toBe('unknown');
    await claim(binding('codex'));
    expect(runs).toEqual(['/usr/bin/codex --version']);
  });

  it('claims nothing for untrusted hooks, an unproven version, a missing Codex, or an unknown harness', async () => {
    const untrusted = await localHarnessCapabilities(() => environment({ config: null }))(binding('codex'));
    expect(Object.values(untrusted!.modes).map(mode => mode.status)).toEqual(['unknown', 'unknown', 'unknown']);
    const old = await localHarnessCapabilities(() => environment({ version: '0.1.0', config: TRUST }))(binding('codex'));
    expect(old!.support).toBe('unsupported');
    expect(await localHarnessCapabilities(() => environment({ version: null }))(binding('codex'))).toBeNull();
    expect(await localHarnessCapabilities(() => { throw new Error('no environment'); })(binding('codex'))).toBeNull();
    expect(await localHarnessCapabilities(() => environment({}))(binding('opencode'))).toBeNull();
  });

  it('keeps every Claude mode unproven', async () => {
    const claude = await localHarnessCapabilities(() => environment({}))(binding('claude'));
    expect(claude!.harness).toBe('claude');
    expect(Object.values(claude!.modes).some(mode => mode.status === 'proven')).toBe(false);
  });
});
