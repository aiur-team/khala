// The Codex app's entries in `setup`, `status` and `remove`. The Codex desktop app reads
// the same `~/.codex` config as the CLI, so a proven desktop route needs only components
// the Codex setup adapter already owns; this module never proposes its own write. A cloud
// task's hooks live in that task's environment, which local setup cannot reach.
import type { ListeningMode } from '@khala/contracts/delivery/index';
import type { SetupComponent, SetupDiagnostic } from '../setup/types.js';

export type CodexAppShape = 'local_chat' | 'cloud_task';

/** One proof-record cell, as the harness evidence table reports it. */
export type CodexAppRouteEvidence = Readonly<{
  shape: CodexAppShape;
  mode: ListeningMode;
  proven: boolean;
  reason: string;
}>;

export type CodexAppSetupContribution = Readonly<{
  /** Codex components a proven desktop route needs; empty while nothing is proven. */
  components: readonly SetupComponent[];
  diagnostics: readonly SetupDiagnostic[];
}>;

const SURFACE: Readonly<Record<CodexAppShape, string>> = {
  local_chat: 'Codex desktop app',
  cloud_task: 'Codex Cloud task',
};

const COMPONENT: Readonly<Record<ListeningMode, SetupComponent>> = { steer: 'hooks', sync: 'hooks', async: 'mcp_entry' };

/**
 * The same entries serve all three commands: the Codex adapter's inspection, which
 * `setup`, `status` and `remove` share, carries them without knowing the command.
 */
export function codexAppSetupContribution(routes: readonly CodexAppRouteEvidence[]): CodexAppSetupContribution {
  const components = new Set<SetupComponent>();
  const diagnostics: SetupDiagnostic[] = [];
  for (const shape of ['local_chat', 'cloud_task'] as const) {
    const cells = routes.filter(route => route.shape === shape);
    const proven = cells.filter(route => route.proven);
    const unproven = cells.filter(route => !route.proven);
    if (shape === 'local_chat') for (const route of proven) components.add(COMPONENT[route.mode]);
    if (shape === 'cloud_task' && proven.length > 0) {
      diagnostics.push({
        code: 'codex_app_task_environment',
        severity: 'warning',
        harness: 'codex',
        message: `${SURFACE[shape]}: ${proven.map(route => route.mode).join(', ')} is proven only with Khala configured `
          + 'in that task\'s environment, which local setup does not change.',
      });
    }
    if (unproven.length > 0) {
      const reasons = [...new Set(unproven.map(route => route.reason))].join(' ');
      diagnostics.push({
        code: 'codex_app_delivery_unproven',
        severity: 'info',
        harness: 'codex',
        message: `${SURFACE[shape]}: delivery is unproven for ${unproven.map(route => route.mode).join(', ')}. `
          + `${reasons} Setup installs nothing for it, so there is nothing to remove.`,
      });
    }
  }
  return { components: [...components].sort(), diagnostics };
}
