export type CodexHook = { type: string; command: string; timeout?: number };
export type CodexHooksFragment = { hooks: Record<string, Array<{ hooks: CodexHook[] }>> };
export function codexHooksFragment(command?: string): CodexHooksFragment;
export function mergeCodexHooks(config: unknown, action: 'install' | 'uninstall', hooksFragment?: CodexHooksFragment): { config: unknown; warnings: string[] };
