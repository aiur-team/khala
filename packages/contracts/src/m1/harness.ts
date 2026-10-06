/** Harness metadata only; wire decoders opt into open ids separately. */
export const HARNESS_ID = /^[a-z][a-z0-9-]{1,23}$/;
export type HarnessId = string;
export function isHarnessId(input: unknown): input is HarnessId {
  return typeof input === 'string' && HARNESS_ID.exec(input)?.[0] === input;
}

export const LEGACY_HARNESSES = ['claude', 'codex', 'cursor'] as const;
export type HarnessInfo = Readonly<{
  id: HarnessId;
  displayName: string;
  modelName: string;
  logoKey: string | null;
  steer: boolean;
  sync: boolean;
  idleWake: 'default' | 'opt-in' | 'none';
  registered: boolean;
}>;

export const HARNESS_REGISTRY: readonly HarnessInfo[] = [
  { id: 'claude', displayName: 'Claude Code', modelName: 'Claude', logoKey: 'claude', steer: true, sync: true, idleWake: 'default', registered: true },
  { id: 'codex', displayName: 'Codex', modelName: 'Codex', logoKey: 'codex', steer: true, sync: true, idleWake: 'default', registered: true },
  { id: 'cursor', displayName: 'Cursor', modelName: 'Cursor', logoKey: 'cursor', steer: true, sync: true, idleWake: 'none', registered: true },
  { id: 'opencode', displayName: 'OpenCode', modelName: 'OpenCode', logoKey: 'opencode', steer: true, sync: true, idleWake: 'default', registered: true },
  { id: 'copilot', displayName: 'Copilot CLI', modelName: 'Copilot', logoKey: 'copilot', steer: true, sync: true, idleWake: 'opt-in', registered: true },
  { id: 'vscode', displayName: 'Copilot (VS Code)', modelName: 'VSCode', logoKey: 'copilot', steer: true, sync: true, idleWake: 'opt-in', registered: true },
  { id: 'gemini', displayName: 'Gemini CLI', modelName: 'Gemini', logoKey: 'gemini', steer: true, sync: true, idleWake: 'opt-in', registered: true },
  // Spike-backed capabilities; transport availability is reported per session.
  { id: 'antigravity', displayName: 'Antigravity CLI', modelName: 'Antigravity', logoKey: null, steer: true, sync: true, idleWake: 'opt-in', registered: true },
  { id: 'qwen', displayName: 'Qwen Code', modelName: 'Qwen', logoKey: 'qwen', steer: true, sync: true, idleWake: 'default', registered: true },
  { id: 'muse', displayName: 'Muse Code', modelName: 'Muse', logoKey: null, steer: true, sync: true, idleWake: 'default', registered: true },
  { id: 'generic', displayName: 'MCP agent', modelName: 'Agent', logoKey: null, steer: false, sync: false, idleWake: 'none', registered: true },
];

export function harnessInfo(id: HarnessId): HarnessInfo {
  return HARNESS_REGISTRY.find(row => row.id === id) ?? {
    id, displayName: id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
    modelName: 'Agent', logoKey: null, steer: false, sync: false, idleWake: 'none', registered: false,
  };
}
