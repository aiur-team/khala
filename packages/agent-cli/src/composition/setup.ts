// Composes the real harness setup adapters and the packaged payload into the one setup
// service behind `khala setup`, `khala remove`, and status configuration. Each adapter also
// supplies the bytes behind the exact plan it returned, so the executor never writes a hash
// it cannot back.
import { claudeAppSetupAdapter } from '../setup/adapters/claude-app.js';
import { createClaudeSetupAdapter } from '../setup/adapters/claude.js';
import { createCodexSetupAdapter } from '../setup/adapters/codex.js';
import { createOpenCodeAdapter } from '../setup/adapters/opencode.js';
import { createCursorSetupAdapter } from '../cursor/setup.js';
import {
  createSetupService, type ComposedSetupAdapter, type SetupExecute, type SetupService,
} from '../setup/plan.js';
import { packagedPayloadSource, readPackagedPayload, type PackagedPayload } from '../setup/payload.js';
import type { SetupEnvironment } from '../setup/types.js';

/** Every harness adapter, in harness order. Claude Desktop reports only and plans nothing. */
export function createSetupAdapters(
  payload: PackagedPayload, nodePath: string, options: Readonly<{ cwd?: string }> = {},
): readonly ComposedSetupAdapter[] {
  const claude = createClaudeSetupAdapter({
    version: payload.version, assets: payload.claudePlugin, nodePath, ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  const codex = createCodexSetupAdapter({ skill: payload.codexSkill });
  const opencode = createOpenCodeAdapter();
  const cursor = createCursorSetupAdapter();
  return [
    {
      harness: 'claude',
      detect: environment => claude.detect(environment),
      inspect: (environment, detection) => claude.inspect(environment, detection),
      plan: request => claude.plan(request),
      planBytes: request => ({ contents: claude.planWithContents(request).contents }),
    },
    {
      ...codex,
      planBytes: request => {
        const plan = codex.executablePlan(request);
        return { contents: plan.contents, entryOwnedPaths: plan.entryOwnedPaths };
      },
    },
    { ...opencode, planBytes: request => ({ contents: opencode.contents(request) }) },
    { ...cursor, planBytes: () => ({ contents: cursor.contents() }) },
    claudeAppSetupAdapter,
  ];
}

export type PackagedSetupOptions = Readonly<{
  /** The package's `dist/` directory, which carries the runtime and the reviewed assets. */
  distDirectory: string;
  /** The Node that runs this CLI; the staged launcher and the Claude hooks run with it. */
  nodePath: string;
  environment: () => SetupEnvironment;
  execute: SetupExecute;
  /** Folder whose Claude trust is reported. */
  cwd?: string;
}>;

/**
 * The packaged setup service. The payload is read on the first setup call, so commands that
 * never touch setup never read it.
 */
export function packagedSetupService(options: PackagedSetupOptions): SetupService {
  let loaded: Promise<SetupService> | undefined;
  const service = () => loaded ??= readPackagedPayload(options.distDirectory).then(payload => createSetupService({
    environment: options.environment,
    adapters: createSetupAdapters(payload, options.nodePath, options.cwd === undefined ? {} : { cwd: options.cwd }),
    execute: options.execute,
    payload: packagedPayloadSource(payload, options.nodePath),
  }));
  return Object.freeze({
    configuration: async () => (await service()).configuration(),
    lifecycle: async (command, lifecycleOptions) => (await service()).lifecycle(command, lifecycleOptions),
  });
}
