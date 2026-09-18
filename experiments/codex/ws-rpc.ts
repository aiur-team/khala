import WebSocket from 'ws';
import { RpcTransportError } from './rpc.js';

export type Message = { method: string; params?: unknown; id?: number | string };

/**
 * JSON-RPC over the app-server Unix listener. Codex 0.154.0 speaks WebSocket on
 * `--listen unix://PATH`; `app-server proxy` only forwards those raw bytes.
 * Server-initiated requests are refused, so no approval can be granted here.
 */
export class WsRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private failure?: RpcTransportError;
  private readonly deadline: ReturnType<typeof setTimeout>;
  private readonly closed: Promise<void>;

  private constructor(private readonly socket: WebSocket, deadlineMs: number,
    private readonly onMessage: (message: Message) => void) {
    this.deadline = setTimeout(() => this.stop(new RpcTransportError('deadline')), deadlineMs);
    this.closed = new Promise(resolve => socket.once('close', () => { this.stop(new RpcTransportError('exited')); resolve(); }));
    socket.on('error', () => this.stop(new RpcTransportError('exited')));
    socket.on('message', (data, binary) => this.dispatch(binary ? '' : data.toString()));
  }

  static connect(socketPath: string, deadlineMs: number, onMessage: (message: Message) => void = () => {}): Promise<WsRpcClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: Math.min(deadlineMs, 10_000), maxPayload: 16 * 1024 * 1024, perMessageDeflate: false, headers: { host: 'localhost' } });
      socket.once('open', () => resolve(new WsRpcClient(socket, deadlineMs, onMessage)));
      socket.once('error', () => reject(new RpcTransportError('spawn')));
    });
  }

  async initialize(name: string): Promise<void> {
    await this.request('initialize', { clientInfo: { name, version: '0.0.0' }, capabilities: { experimentalApi: true } });
    this.notify('initialized');
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: v => resolve(v as T), reject: e => { (e as Error & { method?: string }).method ??= method; reject(e); } });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** Writes a request and resolves once the bytes are flushed, without awaiting any reply. */
  writeOnly(method: string, params: unknown): Promise<void> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => this.socket.send(JSON.stringify({ id, method, params }), e => e ? reject(e) : resolve()));
  }

  notify(method: string, params?: unknown): void { this.send({ method, ...(params === undefined ? {} : { params }) }); }

  /** Abrupt transport loss: no close handshake is sent. */
  terminate(): void { this.socket.terminate(); }

  async close(): Promise<void> {
    this.stop(new RpcTransportError('closed'));
    await this.closed;
  }

  private send(message: unknown): void {
    this.socket.send(JSON.stringify(message), error => { if (error) this.stop(new RpcTransportError('write')); });
  }

  private dispatch(text: string): void {
    let record: Record<string, unknown>;
    try { record = JSON.parse(text); if (!record || typeof record !== 'object') throw new Error(); }
    catch { this.stop(new RpcTransportError('protocol')); return; }
    if (typeof record.method === 'string') {
      this.onMessage(record as Message);
      if (Object.hasOwn(record, 'id')) {
        this.send({ id: record.id, error: { code: -32601, message: 'probe refuses server requests' } });
      }
      return;
    }
    const pending = typeof record.id === 'number' ? this.pending.get(record.id) : undefined;
    if (!pending) return;
    this.pending.delete(record.id as number);
    if (Object.hasOwn(record, 'error')) {
      const error = new RpcTransportError('remote');
      (error as RpcTransportError & { remote?: unknown }).remote = record.error;
      pending.reject(error);
    } else pending.resolve(record.result);
  }

  private stop(error: RpcTransportError): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.deadline);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
  }
}
