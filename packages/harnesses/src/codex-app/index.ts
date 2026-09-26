// Evidence-scoped Codex desktop and Codex Cloud task adapter. It inspects and declares
// capabilities only; delivery runs through the `khala codex-app-hook` handler and
// `khala_read` in the user's own session, never through a session Khala starts.

export {
  CODEX_APP, CODEX_APP_ADAPTER_VERSION, CODEX_APP_BLOCKED_REASONS, CODEX_APP_BOUNDARIES, CODEX_APP_PROOF_RECORD,
  CODEX_APP_PROVEN_CELLS, CODEX_APP_SHAPES, type CodexAppProvenCell, type CodexAppShape,
} from './evidence';
export {
  type CodexAppEnvironment, type CodexAppHookBoundary, type CodexAppInspection, codexAppIdentity, inspectCodexApp,
} from './inspect';
