import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type RpcErrorCode = 'deadline' | 'closed' | 'exited' | 'protocol' | 'spawn' | 'write' | 'remote';

/** Deliberately excludes command arguments, remote error text, and stderr. */
export class RpcTransportError extends Error {
  constructor(readonly code: RpcErrorCode) {
    super(`RPC transport: ${code}`);
    this.name = 'RpcTransportError';
  }
}

export interface RpcClientOptions {
  command: string;
  args: readonly string[];
  /** Absolute lifetime bound, measured from construction, not per request. */
  deadlineMs: number;
  cwd?: string;
  maxLineBytes?: number;
  onNotification?: (message: { method: string; params?: unknown }) => void;
}

export class JsonlRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly deadline: ReturnType<typeof setTimeout>;
  private readonly finished: Promise<void>;
  private finish!: () => void;
  private killTimer?: ReturnType<typeof setTimeout>;
  private ended = false;
  private failure?: RpcTransportError;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly maxLineBytes: number;

  constructor(private readonly options: RpcClientOptions) {
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 2_147_483_647) {
      throw new RangeError('deadlineMs must be a positive timer-safe integer');
    }
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1 || this.maxLineBytes > 1024 * 1024) {
      throw new RangeError('maxLineBytes must be between 1 and 1048576');
    }
    this.finished = new Promise(resolve => { this.finish = resolve; });
    this.child = spawn(options.command, [...options.args], { cwd: options.cwd, stdio: 'pipe', shell: false });
    this.deadline = setTimeout(() => this.stop(new RpcTransportError('deadline')), options.deadlineMs);
    this.child.stderr.resume();
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stdout.on('error', () => this.stop(new RpcTransportError('protocol')));
    this.child.stderr.on('error', () => this.stop(new RpcTransportError('protocol')));
    this.child.stdin.on('error', () => this.stop(new RpcTransportError('write')));
    this.child.on('error', () => this.stop(new RpcTransportError('spawn')));
    this.child.on('close', () => {
      this.ended = true;
      clearTimeout(this.killTimer);
      this.stop(new RpcTransportError('exited'));
      this.finish();
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      void this.write({ id, method, ...(params === undefined ? {} : { params }) }).catch(error => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  async close(): Promise<void> {
    this.stop(new RpcTransportError('closed'));
    await this.finished;
  }

  private async write(message: unknown): Promise<void> {
    if (this.failure) throw this.failure;
    let line: string;
    try { line = JSON.stringify(message) + '\n'; }
    catch { throw new RpcTransportError('protocol'); }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, error => {
        if (error) {
          this.stop(new RpcTransportError('write'));
          reject(this.failure);
        } else resolve();
      });
    });
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    // Check each line before concatenating, including fragmented UTF-8 bytes.
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      if (this.buffer.length + end - offset > this.maxLineBytes) {
        this.stop(new RpcTransportError('protocol'));
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)]);
      if (newline === -1) return;
      const line = this.buffer.toString('utf8');
      this.buffer = Buffer.alloc(0);
      if (!this.dispatch(line)) return;
      offset = newline + 1;
    }
  }

  private dispatch(line: string): boolean {
    try {
      const message: unknown = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
      const record = message as Record<string, unknown>;
      if (Object.hasOwn(record, 'jsonrpc') && record.jsonrpc !== '2.0') throw new Error();
      if (!Object.hasOwn(record, 'id') && typeof record.method === 'string') {
        this.options.onNotification?.({ method: record.method, params: record.params });
        return true;
      }
      if (typeof record.id !== 'number' || !this.pending.has(record.id) ||
          Object.hasOwn(record, 'result') === Object.hasOwn(record, 'error') || Object.hasOwn(record, 'method')) throw new Error();
      if (Object.hasOwn(record, 'error')) {
        const remote = record.error;
        if (!remote || typeof remote !== 'object' || Array.isArray(remote) ||
            !Number.isInteger((remote as Record<string, unknown>).code) ||
            typeof (remote as Record<string, unknown>).message !== 'string') throw new Error();
      }
      const pending = this.pending.get(record.id)!;
      this.pending.delete(record.id);
      if (Object.hasOwn(record, 'error')) pending.reject(new RpcTransportError('remote'));
      else pending.resolve(record.result);
      return true;
    } catch {
      this.stop(new RpcTransportError('protocol'));
      return false;
    }
  }

  private stop(error: RpcTransportError): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.deadline);
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.child.stdin.destroy();
    if (!this.ended) {
      this.child.kill('SIGTERM');
      this.killTimer = setTimeout(() => {
        if (!this.ended) this.child.kill('SIGKILL');
      }, 250);
    }
  }
}
