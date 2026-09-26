import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Checks the Codex app proof record. A Blocked cell must stay `unknown` and cite
// facts that appear verbatim in the host inventory. A Proven cell cites a raw
// trial file, and every fact the gate checks is derived from that file: same-
// session boundary timing, model context, idle delivery, restart, and
// acknowledgement in the user's existing session, never a Khala-started one.

const SHAPES = ["local_chat", "cloud_task"] as const;
const BOUNDARIES: Record<string, string> = { steer: "PostToolUse", sync: "Stop", async: "khala_read" };

// Decisions 34 and 37: `steer` and `sync` must also reach an idle session.
const IDLE_MODES = new Set(["steer", "sync"]);

// Decision 33: every proof runs with normal trust settings. `--yolo` is Codex's
// hidden alias for `--dangerously-bypass-approvals-and-sandbox`.
const TRUST_BYPASS = [
  "--dangerously-bypass-hook-trust",
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--setting-sources",
  "--port",
];

// Option values that turn off the sandbox or approvals just as those flags do,
// passed directly or as a `-c key=value` config override.
const TRUST_BYPASS_VALUES: { options: string[]; bypass: (value: string) => boolean }[] = [
  { options: ["-s", "--sandbox"], bypass: (value) => value === "danger-full-access" },
  { options: ["-a", "--ask-for-approval"], bypass: (value) => value === "never" },
  {
    options: ["-c", "--config"],
    bypass: (value) =>
      /^\s*(?:approval_policy\s*=\s*["']?never|sandbox_mode\s*=\s*["']?danger-full-access)["']?\s*$/.test(value),
  },
];

// A second model session in place of the user's: an app server, a headless run,
// a newly submitted cloud task, or an Agents API/SDK run. Codex accepts global
// options before its subcommand, so the subcommand may sit anywhere after the
// binary.
const HOSTED_SUBCOMMANDS = new Set(["app-server", "exec", "e", "remote-control"]);
const HOSTED_API = [/\/v1\/(?:responses|agents)\b/, /@openai\/agents\b|\bopenai-agents\b/];
const KHALA = /(?:^|[\s/@\\])(?:@aiur\/)?khala\b/i;

type Proc = { pid: number; ppid: number; argv: string[] };

type Event = {
  kind: string;
  at: string;
  sessionId: string;
  appVersion: string;
  launchCommand: string[];
  batch?: string;
  phase?: string;
  hook?: string;
  startedBy?: string;
  appPid?: number;
  createdBy?: string;
  processes?: Proc[];
  hits?: unknown[];
};

type Cell = {
  shape: string;
  mode: string;
  boundary: string;
  status: string;
  support: string;
  evidenceRef: string | null;
  reason?: string;
  inventoryFacts?: string[];
};

const at = (value: string | null | undefined, label: string) => {
  const ms = Date.parse(String(value));
  assert.ok(Number.isFinite(ms), `${label} timestamp missing`);
  return ms;
};

const codexIndex = (argv: string[]) => argv.findIndex((token) => /^codex(?:\.js|\.exe)?$/.test(basename(token)));

export function hostedSession(argv: string[]) {
  const bin = codexIndex(argv);
  if (bin >= 0 && argv.slice(bin + 1).some((token) => HOSTED_SUBCOMMANDS.has(token))) return true;
  return HOSTED_API.some((pattern) => pattern.test(argv.join(" ")));
}

// An option's value follows as the next token, after `=`, or, for a short
// option, attached (`-sdanger-full-access`).
function optionValues(argv: string[], option: string) {
  const short = /^-[a-z]$/.test(option);
  return argv.flatMap((token, index) => {
    if (token === option) return index + 1 < argv.length ? [argv[index + 1]!] : [];
    if (token.startsWith(`${option}=`)) return [token.slice(option.length + 1)];
    if (short && token.startsWith(option) && token.length > 2) return [token.slice(2)];
    return [];
  });
}

export function trustBypass(argv: string[]) {
  const flag = TRUST_BYPASS.find((name) => argv.some((token) => token === name || token.startsWith(`${name}=`)));
  if (flag) return flag;
  for (const { options, bypass } of TRUST_BYPASS_VALUES) {
    for (const option of options) {
      const value = optionValues(argv, option).find(bypass);
      if (value !== undefined) return `${option} ${value}`;
    }
  }
  return undefined;
}

function ancestors(proc: Proc, byPid: Map<number, Proc>) {
  const chain: Proc[] = [];
  for (let next = byPid.get(proc.ppid); next && !chain.includes(next); next = byPid.get(next.ppid)) chain.push(next);
  return chain;
}

function verifyBlocked(cell: Cell, label: string, inventory: string) {
  // Nothing was inspected in a live session, so this is not a proven negative.
  assert.equal(cell.support, "unknown", `${label} blocked cell must report unknown`);
  assert.equal(cell.evidenceRef, null, `${label} blocked cell must not cite evidence`);
  assert.ok((cell.reason ?? "").trim().length > 0, `${label} blocked reason missing`);
  assert.ok((cell.inventoryFacts ?? []).length > 0, `${label} blocked reason cites no inventory fact`);
  for (const fact of cell.inventoryFacts ?? []) {
    assert.ok(inventory.includes(fact), `${label} inventory fact not captured: ${fact}`);
  }
}

async function readTrial(dir: string, ref: string, label: string): Promise<Event[]> {
  const raw = await readFile(join(dir, ref), "utf8").catch(() => assert.fail(`${label} evidence file missing`));
  return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function verifyProven(cell: Cell, label: string, shapeVersion: string | null, dir: string) {
  assert.equal(cell.support, "proven", `${label} proven cell must report proven`);
  assert.ok(cell.evidenceRef, `${label} proven cell has no evidence reference`);
  assert.ok(shapeVersion, `${label} shape has no exact app version`);
  const events = await readTrial(dir, cell.evidenceRef, label);
  const find = (kind: string, match: (event: Event) => boolean = () => true) =>
    events.find((event) => event.kind === kind && match(event));

  // Decision 33: every event names the same session, version, and exact launch
  // command, and that command runs with normal trust settings.
  const start = find("session_start");
  assert.ok(start, `${label} trial has no session start`);
  assert.ok(Array.isArray(start.launchCommand) && start.launchCommand.length > 0, `${label} launch command not recorded`);
  for (const event of events) {
    assert.equal(event.sessionId, start.sessionId, `${label} ${event.kind} session differs from the user's session`);
    assert.equal(event.appVersion, shapeVersion, `${label} app version differs from the shape tuple`);
    assert.deepEqual(event.launchCommand, start.launchCommand, `${label} ${event.kind} launch command differs`);
  }
  const launchBypass = trustBypass(start.launchCommand);
  assert.equal(launchBypass, undefined, `${label} launch command bypasses normal trust settings: ${launchBypass}`);

  // Same session: the user started it before the trial.
  assert.equal(start.startedBy, "user", `${label} session was not started by the user`);
  const trialStart = at(find("trial_start")?.at, `${label} trial start`);
  assert.ok(at(start.at, `${label} session start`) < trialStart, `${label} session started during the trial`);
  if (cell.shape === "cloud_task") {
    const task = find("task_created");
    assert.equal(task?.createdBy, "user", `${label} cloud task was not created by the user`);
    assert.ok(at(task?.at, `${label} task creation`) < trialStart, `${label} cloud task created during the trial`);
  }

  // Census. Decision 24: Khala never launches an agent, so any codex process
  // with a Khala ancestor fails, whatever its subcommand. A hosted model session
  // passes only when the desktop app itself started it (its backend app
  // server); anything started by Khala, orphaned, or of unknown parentage fails.
  const census = find("census")?.processes;
  assert.ok(census, `${label} trial has no process census`);
  const byPid = new Map(census.map((proc) => [proc.pid, proc]));
  if (cell.shape === "local_chat") {
    const app = byPid.get(start.appPid ?? -1);
    assert.deepEqual(app?.argv, start.launchCommand, `${label} launch command is not the running app process`);
  }
  for (const proc of census) {
    const argv = proc.argv.join(" ");
    const chain = ancestors(proc, byPid);
    if (codexIndex(proc.argv) >= 0) {
      const bypass = trustBypass(proc.argv);
      assert.equal(bypass, undefined, `${label} census process bypasses normal trust settings: ${argv}`);
      const khalaParent = chain.some((parent) => KHALA.test(parent.argv.join(" ")));
      assert.ok(!khalaParent, `${label} codex process started by Khala in census: ${argv}`);
    }
    if (!hostedSession(proc.argv)) continue;
    const appStarted = cell.shape === "local_chat" && chain.some((parent) => parent.pid === start.appPid);
    const khalaStarted = [proc, ...chain].some((parent) => KHALA.test(parent.argv.join(" ")));
    assert.ok(appStarted && !khalaStarted, `${label} hosted model session in census: ${argv}`);
  }
  const markers = find("marker_scan")?.hits;
  assert.ok(markers, `${label} trial has no marker scan`);
  assert.equal(markers.length, 0, `${label} marker found in a process argv or environment`);

  // Boundary timing. Delivery must also reach the model: a hook firing alone is
  // only a transport receipt.
  const live = find("enqueue", (event) => event.phase === "active");
  assert.ok(live, `${label} trial has no batch enqueued during the session`);
  const delivered = (batch: string | undefined) => ({
    boundary: find("boundary", (event) => event.batch === batch),
    context: find("model_context", (event) => event.batch === batch),
    ack: find("ack", (event) => event.batch === batch),
  });
  const toolStart = at(find("tool_start")?.at, `${label} tool start`);
  const toolDone = at(find("tool_complete")?.at, `${label} tool completion`);
  const enqueued = at(live.at, `${label} enqueue`);
  const liveDelivery = delivered(live.batch);
  const boundary = at(liveDelivery.boundary?.at, `${label} boundary`);
  const context = at(liveDelivery.context?.at, `${label} model context`);
  const ack = at(liveDelivery.ack?.at, `${label} acknowledgement`);
  assert.equal(liveDelivery.boundary?.hook, cell.boundary, `${label} delivered through the wrong boundary`);
  if (cell.mode === "steer") {
    assert.ok(toolStart < enqueued && enqueued < toolDone, `${label} steer batch not enqueued during the tool`);
  }
  assert.ok(enqueued <= boundary, `${label} boundary before enqueue`);
  if (cell.mode !== "async") {
    assert.ok(toolDone <= boundary, `${label} delivered before the active tool completed`);
  }
  assert.ok(boundary <= context, `${label} model context before the boundary`);
  assert.ok(context <= ack, `${label} acknowledged before model context`);

  // Idle delivery: a batch enqueued while the session sits idle reaches model
  // context with no user turn or tool call in between.
  if (IDLE_MODES.has(cell.mode)) {
    const idleBatch = find("enqueue", (event) => event.phase === "idle");
    assert.ok(idleBatch, `${label} has no idle-session trial`);
    const idleEnqueued = at(idleBatch.at, `${label} idle enqueue`);
    const idleDelivery = delivered(idleBatch.batch);
    const idleContext = at(idleDelivery.context?.at, `${label} idle model context`);
    const idleSince = events.filter((event) => event.kind === "idle" && at(event.at, `${label} idle`) <= idleEnqueued).at(-1);
    assert.ok(idleSince, `${label} idle batch was not enqueued while the session sat idle`);
    const busy = events.some(
      (event) =>
        (event.kind === "tool_start" || event.kind === "user_prompt") &&
        at(event.at, `${label} ${event.kind}`) >= at(idleSince.at, `${label} idle`) &&
        at(event.at, `${label} ${event.kind}`) <= idleContext,
    );
    assert.ok(!busy, `${label} session was not idle before the idle batch reached model context`);
    assert.ok(idleContext <= at(idleDelivery.ack?.at, `${label} idle acknowledgement`), `${label} idle batch acknowledged before model context`);
  }

  // Restart: every batch acknowledged before the restart stays delivered once,
  // and a batch delivered but not acknowledged replays and is then acknowledged.
  const restart = at(find("restart")?.at, `${label} restart`);
  const deliveredAt = (batch: string | undefined) =>
    events.filter((event) => event.kind === "boundary" && event.batch === batch).map((event) => at(event.at, `${label} boundary`));
  const acked = events.filter((event) => event.kind === "ack" && at(event.at, `${label} ack`) < restart).map((event) => event.batch);
  for (const batch of acked) {
    assert.ok(deliveredAt(batch).every((time) => time < restart), `${label} acknowledged batch delivered again after restart`);
  }
  const replayed = events.some((event) => {
    if (event.kind !== "enqueue" || acked.includes(event.batch)) return false;
    const times = deliveredAt(event.batch);
    const replay = times.find((time) => time > restart);
    const ackAfter = find("ack", (item) => item.batch === event.batch);
    return times.some((time) => time < restart) && replay !== undefined && ackAfter !== undefined && replay <= at(ackAfter.at, `${label} ack`);
  });
  assert.ok(replayed, `${label} unacknowledged batch not replayed after restart`);
}

export async function verify(dir: string) {
  const record = JSON.parse(await readFile(join(dir, "cells.json"), "utf8"));
  const inventory = await readFile(join(dir, record.inventory), "utf8");
  const cells: (Cell & { trial?: unknown })[] = record.cells;
  const expected = SHAPES.flatMap((shape) => Object.keys(BOUNDARIES).map((mode) => `${shape}/${mode}`));
  assert.deepEqual(cells.map((cell) => `${cell.shape}/${cell.mode}`).sort(), expected.sort(), "cell set");

  for (const cell of cells) {
    const label = `${cell.shape}/${cell.mode}`;
    assert.equal(cell.boundary, BOUNDARIES[cell.mode], `${label} boundary`);
    // Trial facts come only from the raw evidence file, never from cells.json.
    assert.equal(cell.trial, undefined, `${label} carries trial fields in cells.json`);
    if (cell.status === "blocked") verifyBlocked(cell, label, inventory);
    else if (cell.status === "proven") await verifyProven(cell, label, record.shapes[cell.shape]?.appVersion ?? null, dir);
    else assert.fail(`${label} status must be blocked or proven`);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await verify(process.argv[2] ?? "evidence");
  console.log("codex-app evidence verified");
}
