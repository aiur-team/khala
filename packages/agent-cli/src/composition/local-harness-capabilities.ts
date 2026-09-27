import { type DeliveryLimits, type HarnessCapabilities, decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import { installedClaudeCapabilities } from '@khala/harnesses/claude/interactive';
import { interactiveCodexCapabilities } from '@khala/harnesses/codex/interactive';
import { MAX_SEND_BYTES } from '../cli/send.js';
import { codexHookReviewState } from '../codex/hooks-config.js';
import { parseClaudeVersion } from '../setup/adapters/claude.js';
import { codexPaths, parseCodexVersion } from '../setup/adapters/codex.js';
import type { SetupEnvironment } from '../setup/types.js';
import type { LocalHarnessCapabilities, LocalHarnessObservation } from './internal-listening-mode.js';

// The released capability claim of the harness a local binding runs in, read the
// same way setup reads it. Codex is claimed only for an exactly proven version whose
// Khala hooks the user has trusted; with no receipt proof supplied, `async` stays
// unproven. Claude is claimed for its inspected version: tested only for an exactly
// proven pair, experimental otherwise, and unproven when no version can be read. Any
// other harness, or any inspection failure, claims nothing.

const decoded = decodeDeliveryLimits({ maxPayloadBytes: MAX_SEND_BYTES, maxSelectionEvents: 32 });
if (!decoded.ok) throw new Error('local harness capabilities: invalid delivery limits');
export const LOCAL_DELIVERY_LIMITS: DeliveryLimits = decoded.value;

const text = new TextDecoder('utf-8', { fatal: true });

async function readText(environment: SetupEnvironment, file: string): Promise<string | null> {
  const bytes = await environment.probe.readFile(file);
  return bytes === null ? null : text.decode(bytes);
}

type Inspection = Readonly<{
  capabilities: HarnessCapabilities | null;
  observation: Awaited<ReturnType<LocalHarnessObservation>>;
}>;

const NOTHING: Inspection = { capabilities: null, observation: null };

async function inspectCodex(environment: SetupEnvironment): Promise<Inspection> {
  const executable = await environment.probe.resolveExecutable('codex');
  if (executable === null) return NOTHING;
  const version = parseCodexVersion(await environment.probe.runVersion(executable, ['--version']));
  if (version === null) return NOTHING;
  const paths = codexPaths(environment);
  const hooks = await readText(environment, paths.hooks);
  let hooksJson: unknown = null;
  try { hooksJson = hooks === null ? null : JSON.parse(hooks) as unknown; } catch { hooksJson = null; }
  const review = codexHookReviewState({
    hooksPath: paths.hooks, hooksJson, configToml: await readText(environment, paths.config), launcher: paths.launcher,
  });
  return {
    capabilities: interactiveCodexCapabilities(version, LOCAL_DELIVERY_LIMITS, review),
    observation: { version, hookReview: review.state },
  };
}

/** The installed Claude Code version, read as setup's detection reads it; `null` when it cannot be. */
export async function inspectClaudeVersion(environment: SetupEnvironment): Promise<string | null> {
  try {
    const executable = await environment.probe.resolveExecutable('claude');
    return executable === null ? null : parseClaudeVersion(await environment.probe.runVersion(executable, ['--version']));
  } catch {
    return null;
  }
}

async function inspectClaude(environment: () => SetupEnvironment): Promise<Inspection> {
  let version: string | null;
  try { version = await inspectClaudeVersion(environment()); } catch { version = null; }
  return { capabilities: installedClaudeCapabilities(version, LOCAL_DELIVERY_LIMITS), observation: null };
}

export type LocalHarness = Readonly<{
  capabilities: LocalHarnessCapabilities;
  /** The raw observation the internal server derives the owner's view from; Codex only. */
  observation: LocalHarnessObservation;
}>;

/** Inspects at most once per process; a hook or command is one short-lived process. */
export function localHarness(environment: () => SetupEnvironment): LocalHarness {
  const inspected = new Map<string, Promise<Inspection>>();
  const inspect = (harness: string): Promise<Inspection> => {
    let found = inspected.get(harness);
    if (found === undefined) {
      found = harness === 'codex'
        ? (async () => inspectCodex(environment()))().catch(() => NOTHING)
        : harness === 'claude' ? inspectClaude(environment) : Promise.resolve(NOTHING);
      inspected.set(harness, found);
    }
    return found;
  };
  return {
    capabilities: async binding => (await inspect(binding.harness)).capabilities,
    observation: async binding => (await inspect(binding.harness)).observation,
  };
}

export function localHarnessCapabilities(environment: () => SetupEnvironment): LocalHarnessCapabilities {
  return localHarness(environment).capabilities;
}
