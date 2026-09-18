import { appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitize } from './evidence.ts';

export type Mode = 'idle' | 'busy' | 'disconnect';

export const PRIOR_MARKER = 'prior-marker-claude-alpha';

// Minimal view of the Agent SDK stream; the live driver passes SDK messages through unchanged.
export type StreamMessage = { type: string; subtype?: string; [key: string]: unknown };

export type PermissionDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

export type SessionHandle = {
  messages: AsyncIterable<StreamMessage>;
  send(text: string): void;
  end(): void;
  abort(): void;
};

export type OpenSession = (options: {
  sessionId: string;
  workdir: string;
  canUseTool: (tool: string, input: Record<string, unknown>) => Promise<PermissionDecision>;
}) => SessionHandle;

export type Observation = { kind: string; monotonicMs: number; evidencePath: string; detail?: string };
export type SetupAction = { actor: 'agent' | 'human'; action: string };

// A queue the SDK consumes as its streaming prompt; the session stays open until `end`.
export class Pushable<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: ((result: IteratorResult<T>) => void)[] = [];
  #ended = false;
  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }
  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.#waiters.push(resolve));
      },
    };
  }
}

// Collects every stream message with a monotonic timestamp and lets the scenario wait on predicates.
export class Recorder {
  readonly log: { monotonicMs: number; message: StreamMessage }[] = [];
  readonly observations: Observation[] = [];
  #waiters: { predicate: (message: StreamMessage) => boolean; resolve: (index: number) => void }[] = [];
  #closed = false;
  readonly clock: () => number;
  readonly logName: string;
  constructor(clock: () => number, logName: string) {
    this.clock = clock;
    this.logName = logName;
  }

  record(message: StreamMessage): void {
    const index = this.log.push({ monotonicMs: this.clock(), message }) - 1;
    this.#waiters = this.#waiters.filter(waiter => {
      if (!waiter.predicate(message)) return true;
      waiter.resolve(index);
      return false;
    });
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve(-1);
  }

  get closed(): boolean { return this.#closed; }

  observe(kind: string, index: number | null, detail?: string): void {
    const monotonicMs = index === null || index < 0 ? this.clock() : this.log[index].monotonicMs;
    const evidencePath = index === null || index < 0 ? `${this.logName}#probe` : `${this.logName}#L${index + 1}`;
    this.observations.push({ kind, monotonicMs: Math.round(monotonicMs), evidencePath, ...(detail ? { detail: sanitize(detail) } : {}) });
  }

  // Resolves with the log index of the first matching message at or after `from`, or -1 at the deadline/close.
  waitFor(predicate: (message: StreamMessage) => boolean, deadlineMs: number, from = 0): Promise<number> {
    const existing = this.log.findIndex((entry, index) => index >= from && predicate(entry.message));
    if (existing >= 0) return Promise.resolve(existing);
    if (this.#closed) return Promise.resolve(-1);
    return new Promise(resolve => {
      const waiter = { predicate, resolve: (index: number) => { clearTimeout(timer); resolve(index); } };
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter(entry => entry !== waiter);
        resolve(-1);
      }, Math.max(0, deadlineMs));
      this.#waiters.push(waiter);
    });
  }
}

export const assistantText = (message: StreamMessage): string => {
  if (message.type !== 'assistant') return '';
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content.map(block => (block as { type?: string; text?: string }).type === 'text' ? (block as { text: string }).text : '').join('');
};

export const toolUses = (message: StreamMessage): { id: string; name: string; input: Record<string, unknown> }[] => {
  if (message.type !== 'assistant') return [];
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(block => (block as { type?: string }).type === 'tool_use') as { id: string; name: string; input: Record<string, unknown> }[];
};

export const toolResultFor = (message: StreamMessage, toolUseId: string): string | null => {
  if (message.type !== 'user') return null;
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const block = content.find(item => (item as { type?: string; tool_use_id?: string }).type === 'tool_result' && (item as { tool_use_id?: string }).tool_use_id === toolUseId) as { content?: unknown } | undefined;
  if (!block) return null;
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
};

// The released line never carries the prior marker; the model must recall it from session context.
export const releasedLine = (id: string, nonce: string): string =>
  JSON.stringify({ khala: 'released', id, text: `Released message ${id}: reply with the token ${nonce} and the private context marker you were given earlier in this conversation. Do not use tools for this.` });

export const setupPrompt = (feedPath: string): string => [
  `Your owner shared a Khala chat link with you: file://${feedPath}`,
  'Khala\'s local owner connector appends each message the owner releases to you as one JSON line in that file.',
  `Set up notification yourself so released messages reach this conversation: start the Monitor tool on the command \`tail -n 0 -F ${feedPath}\` with the longest timeout it allows.`,
  'Do not read the file any other way. When a released message arrives, do what its text says.',
  'Reply SETUP-DONE once the watch is running.',
].join('\n');

export const busyPrompt = (seconds: number, tag: string): string =>
  `Run exactly this Bash command in the foreground (not run_in_background): sleep ${seconds} && echo ${tag}. After it finishes, reply BUSY-DONE.`;

export const seedPrompt = (): string =>
  `Private context marker for this conversation: ${PRIOR_MARKER}. Remember it for later in this conversation. Do not write it to any file or tool. Reply exactly MARKER-STORED.`;

export const writeFeedLine = (feedPath: string, line: string): Promise<void> => appendFile(feedPath, `${line}\n`, { mode: 0o600 });

const exec = promisify(execFile);

// Only processes owned by this user whose argv names the probe's unique feed path or session ID.
export async function findProcesses(pattern: string): Promise<number[]> {
  try {
    const { stdout } = await exec('pgrep', ['-u', String(process.getuid?.() ?? ''), '-f', '--', pattern]);
    return stdout.split('\n').filter(Boolean).map(Number).filter(pid => pid !== process.pid);
  } catch { return []; }
}
