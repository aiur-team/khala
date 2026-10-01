import type { ModeSupport } from '@khala/contracts/delivery/index';

/** The saved-session probe was run on this exact installed Claude Code build. */
export const CLAUDE_HOSTED_HOOK_PROBED_VERSION = '2.1.286';
export const CLAUDE_HOSTED_HOOK_EVIDENCE_REF = 'docs/evidence/claude-hosted-native-hooks.md';

export type ClaudeHostedHookBoundary = 'post_tool_use' | 'stop';
export type ClaudeHostedHookGap = 'no_authenticated_hosted_hook_receipt';

/**
 * Handoff to hosted composition: hook output can be model-visible, but the
 * proof-key MCP route has no authenticated hook receipt for its held binding and
 * generation. A Claude version or hook installation cannot turn either mode on.
 * Async is intentionally outside this contract and remains owned by #701.
 */
export type ClaudeHostedNativeModeEvidence = Readonly<{
  version: string;
  receipt: null;
  gap: ClaudeHostedHookGap;
  modes: Readonly<{ steer: ModeSupport; sync: ModeSupport }>;
}>;

export function hostedClaudeNativeModeEvidence(version: string | null): ClaudeHostedNativeModeEvidence {
  const exact = version === CLAUDE_HOSTED_HOOK_PROBED_VERSION;
  const namedVersion = version ?? 'unknown';
  const mode = (name: 'steer' | 'sync', boundary: ClaudeHostedHookBoundary): ModeSupport => ({
    status: exact ? 'unsupported' : 'unknown',
    route: `claude-hosted-proof-key-${name}`,
    ...(exact ? { testedVersion: CLAUDE_HOSTED_HOOK_PROBED_VERSION } : {}),
    evidenceRef: exact ? CLAUDE_HOSTED_HOOK_EVIDENCE_REF : null,
    evidenceRevision: null,
    reason: exact
      ? `Claude Code ${namedVersion} exposes model-visible ${boundary} hook output, but the hosted proof-key route cannot authenticate an exact binding/generation receipt from that hook.`
      : `No exact hosted proof-key ${boundary} hook receipt was inspected for Claude Code ${namedVersion}.`,
  });
  return {
    version: namedVersion,
    receipt: null,
    gap: 'no_authenticated_hosted_hook_receipt',
    modes: { steer: mode('steer', 'post_tool_use'), sync: mode('sync', 'stop') },
  };
}
