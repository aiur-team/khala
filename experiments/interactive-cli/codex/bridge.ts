import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  const temporary = `${inboxPath}.new`;
  const value: Batch = { token: parsed.token, body: parsed.body, arrivedAt: new Date().toISOString() };
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, inboxPath);
  await log({ event: "batch_arrived", mode: parsed.mode, token: parsed.token });
}

async function hook(): Promise<void> {
  const input = JSON.parse(await stdin()) as HookInput;
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

  const alreadyOfferedThisTurn =
    current.offeredSession === input.session_id && current.offeredTurn === input.turn_id;

  const markOffered = async (route: string): Promise<void> => {
    current.offeredAt ??= new Date().toISOString();
    current.offeredSession = input.session_id;
    current.offeredTurn = input.turn_id;
    await writeFile(inboxPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    await log({ event: "delivered", route, token: current.token });
  };

  if (selected === "steer" && input.hook_event_name === "PreToolUse" && !alreadyOfferedThisTurn) {
    await markOffered("PreToolUse");
    process.stdout.write(JSON.stringify({ decision: "block", reason: context(current) }));
    return;
  }

  if (selected === "steer" && input.hook_event_name === "PostToolUse" && !alreadyOfferedThisTurn) {
    await markOffered("PostToolUse");
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: context(current)
      }
    }));
    return;
  }

  if (selected === "steer" && input.hook_event_name === "Stop" && !input.stop_hook_active && !alreadyOfferedThisTurn) {
    await markOffered("Stop");
    process.stdout.write(JSON.stringify({ decision: "block", reason: context(current) }));
    return;
  }

  if (selected === "sync" && input.hook_event_name === "Stop" && !input.stop_hook_active && !alreadyOfferedThisTurn) {
    await markOffered("Stop");
    process.stdout.write(JSON.stringify({ decision: "block", reason: context(current) }));
    return;
  }

  if (selected === "sync" && input.hook_event_name === "UserPromptSubmit" && !alreadyOfferedThisTurn) {
    await markOffered("UserPromptSubmit");
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context(current)
      }
    }));
  }
}

async function read(): Promise<void> {
  const current = await batch();
  await log({ event: "agent_read", token: current?.token, pending: Boolean(current && !current.acknowledgedAt) });
  if (!current || current.acknowledgedAt) {
    process.stdout.write(JSON.stringify({ messages: [] }));
    return;
  }
  process.stdout.write(JSON.stringify({ messages: [{ token: current.token, body: current.body }] }));
}

async function ack(token: string | undefined): Promise<void> {
  if (!token) throw new Error("ack requires a token");
  const current = await batch();
  if (!current || current.token !== token) throw new Error("batch token mismatch");
  const duplicate = Boolean(current.acknowledgedAt);
  if (!duplicate) {
    current.acknowledgedAt = new Date().toISOString();
    await writeFile(inboxPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  }
  await log({ event: "acknowledged", token, duplicate });
}

const [command, argument] = process.argv.slice(2);
switch (command) {
  case "enqueue": await enqueue(); break;
  case "hook": await hook(); break;
  case "read": await read(); break;
  case "ack": await ack(argument); break;
  default: throw new Error("usage: bridge.ts <enqueue|hook|read|ack> [token]");
}
