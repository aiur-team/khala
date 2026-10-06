import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';
import type { Plugin } from '@opencode-ai/plugin';
import { wakeParts } from './composition/wake';

export type DeliveryInput = { session_id: string; event: 'session-start' | 'prompt' | 'post-tool' | 'idle'; prompt?: string; continuation?: boolean; replay?: boolean };
export type Delivery = (input: DeliveryInput) => Promise<string>;
const argv = ['hook', 'deliver', '--harness', 'opencode'];

/** Shell-free hooks. Timeout and output bounds keep a failed CLI out of the user's turn. */
export function cliDelivery(binary: string, directory: string, prefix: string[] = []): Delivery {
  return input => new Promise(resolve => {
    const child = spawn(binary, [...prefix, ...argv], { cwd: directory, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    let stdout = '', finished = false, bytes = 0;
    const decoder = new StringDecoder('utf8');
    const finish = (value = '') => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill(); finish(); }, 5_000);
    child.on('error', () => finish());
    child.stdin.on('error', () => finish());
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      stdout += decoder.write(chunk);
      if (bytes > 128 * 1024) { child.kill(); finish(); }
    });
    child.on('close', code => finish(code === 0 ? stdout + decoder.end() : ''));
    child.stdin.end(JSON.stringify(input));
  });
}

export type PluginClient = { session: { promptAsync(input: { signal?: AbortSignal; path: { id: string }; body: { parts: { type: 'text'; text: string; synthetic?: boolean }[] } }): Promise<{ error?: unknown }> } };
/** The installed CLI is absolute so GUI sessions need no shell PATH setup. */
export function installedCli(env = process.env, home = os.homedir(), platform = process.platform): string {
  const base = platform === 'win32' ? env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    : env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  return path.join(base, 'khala', 'npm', ...(platform === 'win32' ? ['node_modules', 'khala-cli', 'dist', 'khala.mjs'] : ['bin', 'khala']));
}

export function createHooks(client: PluginClient, deliver: Delivery, command: string[]) {
  const sessions = new Map<string, { idle: boolean; inFlight: boolean; continuation: boolean; generation: number; pending: string; failures: number; retryAt: number; abort?: AbortController }>();
  let disposed = false;
  const session = (id: string) => {
    let state = sessions.get(id);
    if (!state) { state = { idle: false, inFlight: false, continuation: false, generation: 0, pending: '', failures: 0, retryAt: 0 }; sessions.set(id, state); }
    return state;
  };
  const idle = async (id: string) => {
    const state = session(id);
    if (disposed || !state.idle || state.inFlight || state.failures >= 3 || Date.now() < state.retryAt) return;
    state.inFlight = true;
    const generation = state.generation;
    try {
      const continuation = state.continuation;
      state.continuation = false;
      let stdout: string;
      if (state.pending) {
        const approval = await deliver({ session_id: id, event: 'idle', replay: true });
        const visible = wakeParts(approval).filter(part => !part.synthetic);
        if (!visible.length) return;
        const cached = wakeParts(state.pending).filter(part => part.synthetic);
        stdout = [...visible, ...cached].map(part => part.text).join('\n');
      } else stdout = await deliver({ session_id: id, event: 'idle', continuation });
      // The CLI has acknowledged the frame: retain it if user activity wins the race.
      state.pending = stdout;
      if (disposed || !state.idle || state.generation !== generation || sessions.get(id) !== state) return;
      const parts = wakeParts(stdout);
      if (!parts.length) return;
      state.idle = false;
      state.continuation = true;
      const abort = new AbortController();
      state.abort = abort;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const cancelled = new Promise<never>((_, reject) => {
          abort.signal.addEventListener('abort', () => reject(new Error('Prompt cancelled')), { once: true });
          deadline = setTimeout(() => abort.abort(), 5_000);
        });
        const result = await Promise.race([
          client.session.promptAsync({ path: { id }, body: { parts }, signal: abort.signal }), cancelled,
        ]);
        if (result.error) throw result.error;
        state.pending = '';
        state.failures = 0;
        state.retryAt = 0;
      } finally {
        clearTimeout(deadline);
        delete state.abort;
      }
    } catch {
      state.failures++;
      if (state.failures === 3 && !disposed) process.stderr.write('Khala: OpenCode wake delivery paused after three request failures; send a message to retry.\n');
      state.retryAt = Date.now() + 2_000 * 2 ** (state.failures - 1);
      if (!disposed && sessions.get(id) === state && state.generation === generation) state.idle = true;
    }
    finally { state.inFlight = false; }
  };
  const timer = setInterval(() => { for (const [id, state] of sessions) if (state.idle) void idle(id); }, 2_000);
  timer.unref();
  const dispose = () => { disposed = true; clearInterval(timer); for (const state of sessions.values()) state.abort?.abort(); sessions.clear(); };
  return {
    dispose,
    config: async (cfg: { mcp?: Record<string, unknown> }) => {
      // Preserve an explicitly configured foreign server.
      cfg.mcp = { khala: { type: 'local', command, enabled: true }, ...cfg.mcp };
    },
    'chat.message': async (input: { sessionID: string; messageID?: string }, output: { parts: { type: string; text?: string; synthetic?: boolean }[] }) => {
      const state = session(input.sessionID);
      state.idle = false; state.generation++;
      if (input.messageID) { state.failures = 0; state.retryAt = 0; }
      const prompt = output.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
      const frame = await deliver({ session_id: input.sessionID, event: 'prompt', prompt });
      if (frame && !disposed) output.parts.push({ type: 'text', text: frame, synthetic: true });
    },
    'tool.execute.before': async (input: { sessionID: string; tool: string }, output: { args: Record<string, unknown> }) => {
      const state = session(input.sessionID);
      state.idle = false; state.generation++;
      if (input.tool.startsWith('khala_')) output.args.khala_session = input.sessionID;
    },
    'tool.execute.after': async (input: { sessionID: string }, output: { output: string; content?: { type: string; text?: string }[] }) => {
      const frame = await deliver({ session_id: input.sessionID, event: 'post-tool' });
      if (!frame || disposed) return;
      if (Array.isArray(output.content)) output.content.push({ type: 'text', text: frame });
      else output.output += frame;
    },
    event: async ({ event }: { event: { type: string; properties: { sessionID?: string; info?: { id: string }; status?: { type: string }; [key: string]: unknown } } }) => {
      if (event.type === 'server.instance.disposed') { dispose(); return; }
      const id = event.properties.sessionID ?? event.properties.info?.id;
      if (!id || disposed) return;
      if (event.type === 'session.deleted') { sessions.get(id)?.abort?.abort(); sessions.delete(id); return; }
      const state = session(id);
      if (event.type === 'session.status' && event.properties.status?.type !== 'idle') {
        state.idle = false; state.generation++; return;
      }
      if (event.type === 'session.idle' || (event.type === 'session.status' && event.properties.status?.type === 'idle')) {
        state.idle = true;
        await idle(id);
      } else if (event.type === 'session.created' || event.type === 'session.updated') {
        await deliver({ session_id: id, event: 'session-start' });
      }
    },
  };
}

const plugin: Plugin = async ({ client, directory }) => {
  const cli = installedCli();
  // Windows npm .cmd shims require a shell; run their Node entry point directly.
  const binary = process.platform === 'win32' ? process.execPath : cli;
  const prefix = process.platform === 'win32' ? [cli] : [];
  return createHooks(client, cliDelivery(binary, directory, prefix), [binary, ...prefix, 'mcp', '--harness', 'opencode']);
};
export default { id: 'khala-opencode', server: plugin };
