// Joins the Codex app proof record (from the harness package) to the setup entries the
// setup planner reports for `setup`, `status` and `remove`.
import { LISTENING_MODES } from '@khala/contracts/delivery/index';
import {
  CODEX_APP_BLOCKED_REASONS, CODEX_APP_PROVEN_CELLS, CODEX_APP_SHAPES, type CodexAppProvenCell,
} from '@khala/harnesses/codex-app/index';
import {
  type CodexAppRouteEvidence, type CodexAppSetupContribution, codexAppSetupContribution,
} from '../codex-app/setup.js';
import type { SetupCommand } from '../setup/types.js';

/**
 * A cell is proven for setup when any exact tuple proves it; the session-time inspection
 * still gates delivery on the observed tuple.
 */
export function codexAppRouteEvidence(
  cells: readonly CodexAppProvenCell[] = CODEX_APP_PROVEN_CELLS,
): readonly CodexAppRouteEvidence[] {
  return CODEX_APP_SHAPES.flatMap(shape => LISTENING_MODES.map(mode => {
    const proven = cells.some(cell => cell.identity.shape === shape && cell.mode === mode);
    return { shape, mode, proven, reason: proven ? '' : CODEX_APP_BLOCKED_REASONS[shape] };
  }));
}

/** The Codex app's contribution to one setup command, from the committed proof record. */
export function codexAppSetupEntries(command: SetupCommand): CodexAppSetupContribution {
  return codexAppSetupContribution(command, codexAppRouteEvidence());
}
