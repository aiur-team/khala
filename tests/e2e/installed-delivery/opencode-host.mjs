// Stands in for the OpenCode process: it imports the plugin module exactly as the
// `plugin` entry in `opencode.json` names it (a `file://` URL), calls its `server`, and
// runs its tools and hooks on request. Only OpenCode's in-process client is a fake,
// one idle TUI session whose `promptAsync` is reported back. The running OpenCode
// version comes from the executable path, as OpenCode's own runtime reports it.
//
//   node opencode-host.mjs <plugin-url> <opencode-exec-path> <directory> <session-id>
//
// Requests arrive as JSON lines on stdin: `{ id, op: 'tool', name, args }` or
// `{ id, op: 'hook', name, input }`. Each is answered `{ id, ok, result | error }`, and
// every `promptAsync` is reported as `{ event: 'prompt', sessionID, text }`.
import readline from 'node:readline';

const [pluginUrl, execPath, directory, sessionId] = process.argv.slice(2);
const MODEL = { providerID: 'anthropic', modelID: 'claude-sonnet-5' };
const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);

const client = {
  session: {
    status: async () => ({ data: {} }),
    get: async () => ({ data: { id: sessionId } }),
    messages: async () => ({
      data: [{ info: { id: 'msg_user_1', sessionID: sessionId, role: 'user', model: MODEL }, parts: [{ type: 'text', text: 'hi' }] }],
    }),
    promptAsync: async options => {
      emit({ event: 'prompt', sessionID: options.path.id, text: options.body.parts[0].text });
      return { data: undefined };
    },
  },
};

let hooks;
try {
  const plugin = (await import(pluginUrl)).default;
  const realExecPath = process.execPath;
  process.execPath = execPath;
  try {
    hooks = await plugin.server({ client, directory });
  } finally {
    process.execPath = realExecPath;
  }
  emit({ event: 'loaded', tools: Object.keys(hooks.tool ?? {}) });
} catch (error) {
  emit({ event: 'failed', error: String(error?.stack ?? error) });
  process.exit(1);
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  try {
    let result;
    if (request.op === 'tool') result = await hooks.tool[request.name].execute(request.args ?? {}, { sessionID: sessionId });
    else if (request.op === 'hook') result = await hooks[request.name](request.input, request.output ?? {});
    else throw new Error(`unknown op ${request.op}`);
    emit({ id: request.id, ok: true, result: result ?? null });
  } catch (error) {
    emit({ id: request.id, ok: false, error: String(error?.message ?? error) });
  }
}
await hooks.dispose?.();
