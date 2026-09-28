// AC5's exact native pair. This only writes a runner profile; it never starts
// an agent, calls a provider, or creates an acceptance ticket.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeDeliveryLimits } from '../../../packages/contracts/src/delivery/decode';
import { installedClaudeCapabilities } from '../../../packages/harnesses/src/claude/interactive';
import { installedOpenCodeCapabilities } from '../../../packages/harnesses/src/opencode/interactive';
import { decodeProfile, planModes } from '../profile';
import type { Profile } from '../types';

export const OPENCODE_VERSION = '1.17.10';
export const CLAUDE_VERSION = '2.1.283';

const limits = (() => {
  const decoded = decodeDeliveryLimits({ maxPayloadBytes: 65_536, maxSelectionEvents: 32 });
  if (!decoded.ok) throw new Error('AC5 profile: invalid delivery limits');
  return decoded.value;
})();

export function openCodeDeepSeekClaudeProfile(input: Readonly<{
  khalaPackage: unknown;
  openCodeModel: string;
  claudeModel: string;
}>): Profile {
  if (!/^deepseek\/[a-z0-9][a-z0-9._-]*$/i.test(input.openCodeModel)) {
    throw new Error('AC5 profile: OpenCode model must name a DeepSeek provider model');
  }
  if (!/^(?:opus|sonnet|haiku|claude-[a-z0-9][a-z0-9._-]*)$/i.test(input.claudeModel)) {
    throw new Error('AC5 profile: Claude model must name a Claude model or native alias');
  }
  const profile = decodeProfile({
    name: 'opencode-deepseek-claude',
    repository: 'aiur-team/khala',
    dispatchLabel: 'agent:todo',
    khalaPackage: input.khalaPackage,
    timeoutMs: 20 * 60_000,
    roles: [
      {
        role: 'a', harness: 'opencode', provider: 'deepseek', model: input.openCodeModel,
        cliVersion: OPENCODE_VERSION,
        capabilities: installedOpenCodeCapabilities(OPENCODE_VERSION, limits),
      },
      {
        role: 'b', harness: 'claude', provider: 'anthropic', model: input.claudeModel,
        cliVersion: CLAUDE_VERSION,
        capabilities: installedClaudeCapabilities(CLAUDE_VERSION, limits),
      },
    ],
  });
  if (planModes(profile).runnable.length === 0) throw new Error('AC5 profile: no shared proven mode');
  return profile;
}

/** The live entry point accepts the wire profile shape, not decodeProfile's internal package union. */
export function openCodeDeepSeekClaudeDocument(input: Parameters<typeof openCodeDeepSeekClaudeProfile>[0]): object {
  const profile = openCodeDeepSeekClaudeProfile(input);
  return { ...profile, khalaPackage: input.khalaPackage };
}

function main(argv: readonly string[]): void {
  if (argv.length !== 3) {
    throw new Error('usage: pnpm exec tsx --conditions=khala-source scripts/acceptance/profiles/opencode-deepseek-claude.ts <pack-result.json> <deepseek/model> <claude-model>');
  }
  const [packResult, openCodeModel, claudeModel] = argv;
  const packed = JSON.parse(fs.readFileSync(packResult!, 'utf8')) as { khalaPackage?: unknown };
  process.stdout.write(`${JSON.stringify(openCodeDeepSeekClaudeDocument({
    khalaPackage: packed.khalaPackage, openCodeModel: openCodeModel!, claudeModel: claudeModel!,
  }), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
