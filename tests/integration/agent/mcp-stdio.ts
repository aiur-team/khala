import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export type McpToolResult = { structuredContent: Record<string, unknown>; isError?: boolean };

export function startMcp({ env }: { env: NodeJS.ProcessEnv }): {
  call(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
} {
  const bin = fileURLToPath(new URL('../../../packages/agent/bin/khala.mjs', import.meta.url));
  const child = spawn(process.execPath, [bin, 'mcp', '--harness', 'claude'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 0;
  let terminal: Error | undefined;
  let closing: Promise<void> | undefined;
  const fail = (error: Error) => {
    terminal = error;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear();
  };
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => {
      fail(new Error('mcp_exited'));
      lines.close();
      resolve({ code, signal });
    });
  });
  child.on('error', () => fail(new Error('mcp_spawn_failed')));
  child.stdin.on('error', () => fail(new Error('mcp_stdin_failed')));
  lines.on('line', line => {
    let response: { id?: unknown; error?: unknown; result?: unknown };
    try { response = JSON.parse(line); } catch { fail(new Error('mcp_invalid_response')); return; }
    if (!response || typeof response.id !== 'number') return;
    const call = pending.get(response.id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(response.id);
    if (response.error) call.reject(new Error('mcp_rpc_error'));
    else call.resolve(response.result);
  });
  const request = (method: string, params: Record<string, unknown>, label: string): Promise<unknown> => {
    if (terminal) return Promise.reject(terminal);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`mcp_timeout:${label}`));
      }, 60_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const initialized = request('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'khala-integration', version: '1' },
  }, 'initialize').then(() => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  });
  // A startup failure may precede the test's first call; preserve it for call().
  void initialized.catch(() => {});
  return {
    async call(name, args) {
      if (closing) throw new Error('mcp_closed');
      await initialized;
      return await request('tools/call', { name, arguments: args }, name) as McpToolResult;
    },
    close() {
      return closing ??= (async () => {
        child.stdin.end();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('mcp_close_timeout')); }, 10_000);
          })]);
          if (result.code !== 0 || result.signal !== null) throw new Error('mcp_exit_failed');
        } finally { if (timer) clearTimeout(timer); }
      })();
    },
  };
}
