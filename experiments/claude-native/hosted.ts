import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type HostedEvent = Record<string, unknown>;
export type HostedMode = 'new' | 'resume';

const HOSTED_ENV_KEYS = new Set([
  'ALL_PROXY',
  'COLORTERM',
  'DBUS_SESSION_BUS_ADDRESS',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'TMPDIR',
  'USER',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

const HOSTED_ENV_PREFIXES = [
  'ANTHROPIC_',
  'AWS_',
  'AZURE_',
  'GOOGLE_',
  'LC_',
  'VERTEX_',
  'XDG_',
];

const HOSTED_CLAUDE_ENV_KEYS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CONFIG_DIR',
]);

export function buildHostedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      HOSTED_ENV_KEYS.has(key)
      || HOSTED_CLAUDE_ENV_KEYS.has(key)
      || HOSTED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))
    ) result[key] = value;
  }
  return result;
}

export function buildHostedArgs(sessionId: string, mode: HostedMode = 'resume'): string[] {
  return [
    '-p',
    mode === 'new' ? '--session-id' : '--resume', sessionId,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--replay-user-messages',
    '--include-hook-events',
    '--permission-prompts', 'none',
    '--verbose',
  ];
}

export function buildStreamUserMessage(payload: string): string {
  const payloadBytes = Buffer.byteLength(payload);
  if (payloadBytes < 1 || payloadBytes > 65_536) throw new Error('payload must be 1-65536 bytes');
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
  return null;
}

export class HostedEventClassifier {
  readonly nonce: string;
  #consumed = false;
  #completed = false;

  constructor(nonce: string) {
    this.nonce = nonce;
  }

  classify(event: HostedEvent): HostedObservation | null {
    const observation = classifyHostedEvent(event, this.nonce);
    if (observation === 'context_consumed') this.#consumed = true;
    const resultText = typeof event.result === 'string' ? event.result : '';
    if (event.type === 'result' && this.#consumed && resultText.includes(this.nonce) && !this.#completed) {
      this.#completed = true;
      return 'completed';
    }
    return observation;
  }
}

export class HostedSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: HostedEvent[] = [];
  readonly parseErrors: string[] = [];
  stderrTail = '';
  #waiters = new Set<{ predicate: (event: HostedEvent) => boolean; resolve: (event: HostedEvent | null) => void; timer: NodeJS.Timeout }>();
  #exitPromise: Promise<number | null>;
  #closePromise?: Promise<number | null>;

  constructor(sessionId: string, workdir: string, binary = 'claude', mode: HostedMode = 'resume') {
    this.child = spawn(binary, buildHostedArgs(sessionId, mode), {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildHostedEnv(),
    });
    this.#exitPromise = new Promise(resolve => {
      this.child.once('exit', code => {
        this.#settleWaiters();
        resolve(code);
      });
    });
    const lines = createInterface({ input: this.child.stdout });
    this.child.stderr.on('data', chunk => {
      this.stderrTail = `${this.stderrTail}${Buffer.from(chunk).toString('utf8')}`.slice(-8_192);
    });
    lines.on('line', line => {
      let event: HostedEvent;
      try { event = JSON.parse(line) as HostedEvent; }
      catch { this.parseErrors.push('invalid_json_line'); return; }
      this.events.push(event);
      for (const waiter of [...this.#waiters]) {
        if (!waiter.predicate(event)) continue;
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        waiter.resolve(event);
      }
    });
  }

  send(payload: string): Promise<void> {
    const line = buildStreamUserMessage(payload);
    return new Promise((resolve, reject) => this.child.stdin.write(line, 'utf8', error => error ? reject(error) : resolve()));
  }

  waitFor(predicate: (event: HostedEvent) => boolean, deadlineMs: number, fromIndex = 0): Promise<HostedEvent | null> {
    const start = Math.max(0, Math.trunc(fromIndex));
    for (let index = start; index < this.events.length; index++) {
      const event = this.events[index];
      if (event && predicate(event)) return Promise.resolve(event);
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve(null);
    return new Promise(resolve => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          resolve(null);
        }, deadlineMs),
      };
      this.#waiters.add(waiter);
    });
  }

  async close(): Promise<number | null> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.#exitPromise;
    if (this.#closePromise) return this.#closePromise;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5_000);
    this.#closePromise = this.#exitPromise.finally(() => clearTimeout(timer));
    return this.#closePromise;
  }

  abort(): void {
    this.child.kill('SIGKILL');
  }

  #settleWaiters(): void {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.#waiters.clear();
  }
}
