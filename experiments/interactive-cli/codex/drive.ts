import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Khala-side driver for live trials. The body arrives on stdin and reaches the
// bridge on stdin; neither this process nor the wake carries it in argv.
//
//   drive.ts <fixture-dir> <mode> <token> <trigger> [options] < body
//
// trigger: `now`, or `tool-start:<text>` to wait for a PreToolUse whose command
// contains <text>, then `--delay <ms>` more so the batch lands mid-tool.
// `--session <id>` records the target session. `--wake <codex-binary>` then runs
// a fixed content-free `codex queue` for that session. `--kill-on-delivery`
// SIGKILLs the Codex process that received the offer, before it can acknowledge.
const [fixtureDir, mode, token, trigger, ...options] = process.argv.slice(2);
if (!fixtureDir || !mode || !token || !trigger) {
  throw new Error("usage: drive.ts <fixture-dir> <mode> <token> <trigger> [options] < body");
}
const option = (name: string) => {
  const index = options.indexOf(name);
  return index >= 0 ? options[index + 1] : undefined;
};
const delay = Number(option("--delay") ?? 0);
const session = option("--session");
const wakeBinary = option("--wake");
const killOnDelivery = options.includes("--kill-on-delivery");
const root = resolve(fixtureDir);
const logPath = join(root, "events.jsonl");
const bridge = resolve(import.meta.dirname, "bridge.ts");
const WAKE_TEXT = "Khala: new channel activity. This notice carries no message content.";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const body = Buffer.concat(chunks).toString("utf8").trim();
if (!body) throw new Error("body is required on stdin");

async function events(): Promise<Record<string, unknown>[]> {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(match: (event: Record<string, unknown>) => boolean, after: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await events()).slice(after).find(match);
    if (found) return found;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("timed out waiting for event");
}

async function driverLog(event: Record<string, unknown>): Promise<void> {
  await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), event: "driver", ...event })}\n`);
}

const start = (await events()).length;
if (trigger.startsWith("tool-start:")) {
  const text = trigger.slice("tool-start:".length);
  const started = await waitFor((event) => event.event === "hook" && event.hookEvent === "PreToolUse" &&
    typeof event.toolCommand === "string" && event.toolCommand.includes(text), start, 600_000);
  await driverLog({ step: "tool_started", toolStartAt: started.at, token });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
} else if (trigger !== "now") {
  throw new Error("unknown trigger");
}

const enqueue = spawnSync(process.execPath, [bridge, "enqueue"], {
  env: { ...process.env, KHALA_FIXTURE_DIR: root },
  input: JSON.stringify({ mode, token, body, session }),
  encoding: "utf8"
});
if (enqueue.status !== 0) throw new Error(enqueue.stderr);

if (wakeBinary) {
  if (!session) throw new Error("--wake requires --session");
  const wake = spawnSync(wakeBinary, ["queue", "--thread", session, "--message", WAKE_TEXT], { encoding: "utf8" });
  await driverLog({ step: "wake_sent", token, status: wake.status, receipt: wake.stdout.trim().slice(0, 80) });
  if (wake.status !== 0) throw new Error(wake.stderr);
}

if (killOnDelivery) {
  const delivered = await waitFor((event) => event.event === "delivered" && event.token === token, start, 600_000);
  const pid = Number(delivered.codexPid);
  if (!pid) throw new Error("delivery did not record the Codex pid");
  execFileSync("kill", ["-KILL", String(pid)]);
  await driverLog({ step: "codex_killed_after_offer", token, codexPid: pid, deliveredAt: delivered.at });
}
