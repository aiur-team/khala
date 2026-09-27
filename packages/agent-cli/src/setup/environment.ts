import path from 'node:path';
import { createNodeSetupProbe } from './detect.js';
import { resolveSetupPaths } from './paths.js';
import type { SetupEnvironment } from './types.js';

/** Builds the setup environment from explicit HOME/XDG/CODEX_HOME/PATH values only; nothing else is inherited. */
export function setupEnvironment(env: NodeJS.ProcessEnv): SetupEnvironment {
  const paths = resolveSetupPaths(env);
  const probeEnvironment = {
    HOME: paths.home, XDG_CONFIG_HOME: paths.configHome, XDG_DATA_HOME: paths.dataHome,
    XDG_STATE_HOME: paths.stateHome, CODEX_HOME: paths.codexHome, PATH: paths.pathEntries.join(path.delimiter),
  };
  return {
    home: paths.home, xdgConfigHome: paths.configHome, xdgDataHome: paths.dataHome, xdgStateHome: paths.stateHome,
    codexHome: paths.codexHome,
    probe: createNodeSetupProbe({ pathEntries: paths.pathEntries, environment: probeEnvironment }),
  };
}
