import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type HostedEvent = Record<string, unknown>;

export function buildHostedArgs(sessionId: string): string[] {
  return [
    '-p',
    '--resume', sessionId,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--replay-user-messages',
    '--include-hook-events',
    '--permission-prompts', 'none',
  ];
}

export function buildStreamUserMessage(payload: string): string {
  if (Buffer.byteLength(payload) < 1 || Buffer.byteLength(payload) > 65_536) throw new Error('payload must be 1-65536 bytes');
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: payload },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
  })}\n`;
}

function assistantText(event: HostedEvent): string {
  if (event.type !== 'assistant') return '';
  const content = (event.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    const value = block as { type?: string; text?: string };
    return value.type === 'text' && typeof value.text === 'string' ? value.text : '';
  }).join('');
}

function userText(event: HostedEvent): string {
  if (event.type !== 'user') return '';
  const content = (event.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    const value = block as { type?: string; text?: string };
    return value.type === 'text' && typeof value.text === 'string' ? value.text : '';
  }).join('');
}

export type HostedObservation = 'user_replayed' | 'context_consumed' | 'hook_event' | 'completed';

export function classifyHostedEvent(event: HostedEvent, nonce: string): HostedObservation | null {
  if (userText(event).includes(nonce)) return 'user_replayed';
  if (assistantText(event).includes(nonce)) return 'context_consumed';
  if (event.type === 'system' && typeof event.subtype === 'string' && event.subtype.includes('hook')) return 'hook_event';
  if (event.type === 'result') return 'completed';
  return null;
}

export class HostedSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: HostedEvent[] = [];
  readonly parseErrors: string[] = [];
  #waiters: { predicate: (event: HostedEvent) => boolean; resolve: (event: HostedEvent | null) => void; timer: NodeJS.Timeout }[] = [];

  constructor(sessionId: string, workdir: string, binary = 'claude') {
    this.child = spawn(binary, buildHostedArgs(sessionId), {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let event: HostedEvent;
      try { event = JSON.parse(line) as HostedEvent; }
      catch { this.parseErrors.push('invalid_json_line'); return; }
      this.events.push(event);
      for (const waiter of [...this.#waiters]) {
        if (!waiter.predicate(event)) continue;
        clearTimeout(waiter.timer);
        this.#waiters = this.#waiters.filter(item => item !== waiter);
        waiter.resolve(event);
      }
    });
  }

  send(payload: string): Promise<void> {
    const line = buildStreamUserMessage(payload);
    return new Promise((resolve, reject) => this.child.stdin.write(line, 'utf8', error => error ? reject(error) : resolve()));
  }

  waitFor(predicate: (event: HostedEvent) => boolean, deadlineMs: number): Promise<HostedEvent | null> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.#waiters = this.#waiters.filter(item => item !== waiter);
          resolve(null);
        }, deadlineMs),
      };
      this.#waiters.push(waiter);
    });
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return new Promise(resolve => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 5_000);
      this.child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
  }

  abort(): void {
    this.child.kill('SIGKILL');
  }
}
