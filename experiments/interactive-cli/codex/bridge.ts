import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Mode = "steer" | "sync" | "async";

interface Batch {
  token: string;
  body: string;
  arrivedAt: string;
  acknowledgedAt?: string;
  offeredAt?: string;
  offeredSession?: string;
  offeredTurn?: string;
}

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  tool_name?: string;
  stop_hook_active?: boolean;
  prompt?: string;
}

const root = process.env.KHALA_FIXTURE_DIR;
if (!root) throw new Error("KHALA_FIXTURE_DIR is required");

const inboxPath = join(root, "inbox.json");
const modePath = join(root, "mode");
const logPath = join(root, "events.jsonl");
const lockPath = join(root, "inbox.lock");

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function log(event: Record<string, unknown>): Promise<void> {
  await mkdir(root!, { recursive: true, mode: 0o700 });
  await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

async function mode(): Promise<Mode> {
  return (await readFile(modePath, "utf8")).trim() as Mode;
}

async function batch(): Promise<Batch | undefined> {
  try {
    return JSON.parse(await readFile(inboxPath, "utf8")) as Batch;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function withLock<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        return await operation();
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
}

async function writeBatch(current: Batch): Promise<void> {
  const temporary = `${inboxPath}.${process.pid}.${Date.now()}.new`;
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, inboxPath);
}

function context(current: Batch): string {
  const bridge = process.argv[1];
  return [
    "Khala channel message received.",
    `Batch token: ${current.token}`,
    `Message: ${current.body}`,
    `After acting on this message, run: node ${JSON.stringify(bridge)} ack ${JSON.stringify(current.token)}`
  ].join("\n");
}

async function enqueue(): Promise<void> {
  const parsed = JSON.parse(await stdin()) as { mode: Mode; token: string; body: string };
  if (!(["steer", "sync", "async"] as string[]).includes(parsed.mode)) throw new Error("invalid mode");
  if (!parsed.token || !parsed.body) throw new Error("token and body are required");
  await mkdir(root!, { recursive: true, mode: 0o700 });
  await writeFile(modePath, `${parsed.mode}\n`, { mode: 0o600 });
  const value: Batch = { token: parsed.token, body: parsed.body, arrivedAt: new Date().toISOString() };
  await withLock(() => writeBatch(value));
  await log({ event: "batch_arrived", mode: parsed.mode, token: parsed.token });
}

async function hook(): Promise<void> {
  const input = JSON.parse(await stdin()) as HookInput;
  if (!input.session_id || !input.turn_id) throw new Error("hook requires session_id and turn_id");
  const selected = await mode();
  const current = await batch();
  await log({
    event: "hook",
    hookEvent: input.hook_event_name,
    mode: selected,
    token: current?.token,
    pending: Boolean(current && !current.acknowledgedAt),
    toolName: input.tool_name,
    stopHookActive: input.stop_hook_active ?? false
  });
  if (!current || current.acknowledgedAt) return;

  const claim = async (route: string): Promise<Batch | undefined> => withLock(async () => {
    const latest = await batch();
    if (!latest || latest.acknowledgedAt ||
        (latest.offeredSession === input.session_id && latest.offeredTurn === input.turn_id)) return undefined;
    latest.offeredAt ??= new Date().toISOString();
    latest.offeredSession = input.session_id;
    latest.offeredTurn = input.turn_id;
    await writeBatch(latest);
    await log({ event: "delivered", route, token: latest.token });
    return latest;
  });

  const deliver = async (route: string, output: (claimed: Batch) => unknown): Promise<boolean> => {
    const claimed = await claim(route);
    if (!claimed) return false;
    process.stdout.write(JSON.stringify(output(claimed)));
    return true;
  };

  if (selected === "steer" && input.hook_event_name === "PreToolUse") {
    await deliver("PreToolUse", (claimed) => ({ decision: "block", reason: context(claimed) }));
    return;
  }

  if (selected === "steer" && input.hook_event_name === "PostToolUse") {
    await deliver("PostToolUse", (claimed) => ({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: context(claimed)
      }
    }));
    return;
  }

  if (selected === "steer" && input.hook_event_name === "Stop" && !input.stop_hook_active) {
    await deliver("Stop", (claimed) => ({ decision: "block", reason: context(claimed) }));
    return;
  }

  if (selected === "sync" && input.hook_event_name === "Stop" && !input.stop_hook_active) {
    await deliver("Stop", (claimed) => ({ decision: "block", reason: context(claimed) }));
    return;
  }

  if (selected === "sync" && input.hook_event_name === "UserPromptSubmit") {
    await deliver("UserPromptSubmit", (claimed) => ({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context(claimed)
      }
    }));
  }
}

async function read(): Promise<void> {
  const [session, turn] = process.argv.slice(3);
  if (!session || !turn) throw new Error("read requires session and turn IDs");
  const current = await withLock(async () => {
    const latest = await batch();
    if (!latest || latest.acknowledgedAt ||
        (latest.offeredSession === session && latest.offeredTurn === turn)) return undefined;
    latest.offeredAt ??= new Date().toISOString();
    latest.offeredSession = session;
    latest.offeredTurn = turn;
    await writeBatch(latest);
    return latest;
  });
  await log({ event: "agent_read", token: current?.token, pending: Boolean(current && !current.acknowledgedAt) });
  if (!current || current.acknowledgedAt) {
    process.stdout.write(JSON.stringify({ messages: [] }));
    return;
  }
  process.stdout.write(JSON.stringify({ messages: [{ token: current.token, body: current.body }] }));
}

async function ack(token: string | undefined): Promise<void> {
  if (!token) throw new Error("ack requires a token");
  const duplicate = await withLock(async () => {
    const current = await batch();
    if (!current || current.token !== token) throw new Error("batch token mismatch");
    if (current.acknowledgedAt) return true;
    current.acknowledgedAt = new Date().toISOString();
    await writeBatch(current);
    return false;
  });
  await log({ event: "acknowledged", token, duplicate });
}

const [command, argument] = process.argv.slice(2);
switch (command) {
  case "enqueue": await enqueue(); break;
  case "hook": await hook(); break;
  case "read": await read(); break;
  case "ack": await ack(argument); break;
  default: throw new Error("usage: bridge.ts <enqueue|hook|read SESSION TURN|ack TOKEN>");
}
