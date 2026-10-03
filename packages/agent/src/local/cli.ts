import { setTimeout as sleepDefault } from 'node:timers/promises';
import { isLocalRoomId, type HelperFile, type LocalChannelsPage } from '@khala/contracts/m1/local';
import { StateError } from '../state';
import { ensureHelper, readHelperFile } from './lifecycle';
import { runHelper, type RunHelperOptions } from './serve';

export type LocalCliDeps = {
  env?: NodeJS.ProcessEnv;
  ensureHelper?: (env: NodeJS.ProcessEnv) => Promise<{ origin: string; adminToken: string }>;
  readHelperFile?: (env: NodeJS.ProcessEnv) => Promise<HelperFile | null>;
  fetch?: typeof fetch; serve?: (options: RunHelperOptions) => Promise<number>;
  stdout?: (line: string) => void; stderr?: (line: string) => void;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
};
class CliError extends Error { constructor(readonly code: string) { super(code); } }
const arities: Record<string, readonly [number, number]> = {
  create: [0, 1], link: [1, 1], open: [0, 1], list: [0, 0], delete: [1, 1], status: [0, 0], stop: [0, 0], serve: [0, 0],
};
export async function runLocalCommand(argv: readonly string[], deps: LocalCliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? (line => { process.stdout.write(line); });
  const stderr = deps.stderr ?? (line => { process.stderr.write(line); });
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const print = (value: unknown) => stdout(JSON.stringify(value) + '\n');
  async function health(file: HelperFile): Promise<{ version: string } | null> {
    try {
      const response = await fetchImpl(file.origin + '/healthz', { signal: AbortSignal.timeout(500) });
      if (response.status !== 200) { await response.body?.cancel(); return null; }
      const body = await response.json();
      return body?.ok === true && body.pid === file.pid && typeof body.version === 'string' ? body : null;
    } catch { return null; }
  }
  try {
    const [command = '', ...args] = argv;
    const arity = arities[command];
    if (!arity || args.length < arity[0] || args.length > arity[1]) throw new CliError('invalid_arguments');
    if (command === 'serve') return await (deps.serve ?? runHelper)({ env });
    let connection: { origin: string; adminToken: string };
    let file: HelperFile | null = null;
    let healthy: { version: string } | null = null;
    if (command === 'status' || command === 'stop') {
      file = await (deps.readHelperFile ?? readHelperFile)(env);
      healthy = file ? await health(file) : null;
      if (!file || !healthy) { print(command === 'status' ? { running: false } : { stopped: false }); return 0; }
      connection = file;
    } else {
      try { connection = await (deps.ensureHelper ?? ensureHelper)(env); }
      catch (error) { throw error instanceof StateError ? error : new CliError('helper_unavailable'); }
    }
    async function call(method: string, endpoint: string, body?: unknown): Promise<unknown> {
      let response: Response;
      try {
        response = await fetchImpl(connection.origin + endpoint, {
          method, headers: { authorization: `Bearer ${connection.adminToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
        });
      } catch { throw new CliError('helper_unavailable'); }
      if (response.status === 204) return null;
      let value: unknown;
      try { value = await response.json(); } catch { throw new CliError(response.status === 404 ? 'not_found' : 'internal_error'); }
      if (!response.ok) throw new CliError(response.status === 404 ? 'not_found' : typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string' ? value.error : 'internal_error');
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CliError('internal_error');
      return value;
    }
    async function channels(): Promise<LocalChannelsPage['channels']> {
      const page = await call('GET', '/api/local/channels') as LocalChannelsPage;
      if (!Array.isArray(page?.channels)) throw new CliError('internal_error');
      return page.channels;
    }
    async function resolveChannel(arg: string): Promise<string> {
      if (isLocalRoomId(arg)) return arg;
      const matches = (await channels()).filter(channel => channel.name === arg);
      if (matches.length !== 1) throw new CliError(matches.length ? 'ambiguous_channel' : 'not_found');
      return matches[0]!.roomId;
    }
    async function webHint() {
      try {
        const response = await fetchImpl(connection.origin + '/', { signal: AbortSignal.timeout(500) });
        if (response.status === 503 && (await response.json()).error === 'web_not_built') stderr('khala: web app not built; run pnpm --filter @khala/web build:local\n');
        else await response.body?.cancel();
      } catch { /* The optional web hint does not change command success. */ }
    }
    let result: unknown;
    switch (command) {
      case 'create': {
        const date = new Date(now());
        const name = args[0] ?? `local-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        result = await call('POST', '/api/local/channels', { name });
        await webHint(); break;
      }
      case 'link': result = await call('POST', `/api/local/channels/${encodeURIComponent(await resolveChannel(args[0]!))}/links`); break;
      case 'open': result = await call('POST', '/api/local/open', args[0] === undefined ? {} : { roomId: await resolveChannel(args[0]) }); await webHint(); break;
      case 'list': result = { channels: await channels() }; break;
      case 'delete': {
        const roomId = await resolveChannel(args[0]!);
        await call('DELETE', `/api/local/channels/${encodeURIComponent(roomId)}`);
        result = { deleted: roomId }; break;
      }
      case 'status': result = { running: true, origin: file!.origin, pid: file!.pid, version: healthy!.version, channels: (await channels()).length }; break;
      case 'stop': {
        if (await call('POST', '/api/local/shutdown') !== null) throw new CliError('internal_error');
        const deadline = now() + 2000;
        for (let attempt = 0; attempt < 20 && now() < deadline; attempt++) {
          if (!await health(file!)) break;
          await (deps.sleep ?? sleepDefault)(100);
        }
        result = { stopped: true }; break;
      }
    }
    print(result); return 0;
  } catch (error) {
    print({ error: error instanceof CliError || error instanceof StateError ? error.code : 'internal_error' }); return 1;
  }
}
export default async function main(argv: readonly string[]): Promise<number> {
  const code = await runLocalCommand(argv);
  if (argv.length === 1 && argv[0] === 'serve') setImmediate(() => process.exit(code));
  return code;
}
