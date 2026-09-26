export type HookRole = 'user-prompt-submit' | 'post-tool-use' | 'stop' | 'stop-watcher' | 'session-end';
export type KhalaOp = 'pull' | 'hook' | 'pending';
export type KhalaResult = Readonly<{ code: number; stdout: string }>;

export type HookDependencies = Readonly<{
  /** One `khala claude <op> --session <id>` call. */
  khala(op: KhalaOp, sessionId: string): Promise<KhalaResult>;
  stateRoot: string;
  sleep(ms: number): Promise<void>;
  now(): number;
  nonce(): string;
  parentAlive(): boolean;
}>;

export type HookResult = Readonly<{ stdout: string; stderr: string; exitCode: 0 | 2 }>;

export const WAKE_NOTICE: string;
export const MAX_FRAME_BYTES: number;
export const KHALA_CALL_TIMEOUT_MS: number;
export const WATCHER_HOOK_TIMEOUT_SECONDS: number;
export const WATCH_POLL_MS: number;
export const HOOK_ROLES: Readonly<Record<HookRole, string>>;

export function validSessionId(value: unknown): value is string;
export function decodeHookInput(
  role: HookRole, raw: string,
): Readonly<{ event: string; sessionId: string; stopHookActive: boolean }> | null;
export function validFrame(text: unknown): boolean;
export function renderDelivery(frame: string): string;
export function describeDelivery(input: Readonly<{
  support?: Readonly<Partial<Record<'steer' | 'sync' | 'async', string>>>;
  acknowledgement?: string;
  watcher?: string | null;
}>): Readonly<Record<'steer' | 'sync' | 'async' | 'idle' | 'acknowledgement', string>>;
export function readWatcher(deps: HookDependencies, sessionId: string): Promise<string | null>;
export function defaultDependencies(env?: Readonly<Record<string, string | undefined>>): HookDependencies;
export function runHook(role: HookRole, raw: string, deps: HookDependencies): Promise<HookResult>;
export function main(role: HookRole): Promise<void>;
