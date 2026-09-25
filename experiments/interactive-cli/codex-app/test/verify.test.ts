import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { trustBypass, verify } from "../verify.ts";

const SESSION = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const VERSION = "26.925.0";
const APP_PID = 4100;
const LAUNCH: Record<string, string[]> = {
  local_chat: ["/opt/Codex/codex-desktop"],
  cloud_task: ["codex", "--cd", "/workspace/repo"],
};
const HOOKS: Record<string, string> = { steer: "PostToolUse", sync: "Stop", async: "khala_read" };

type Event = Record<string, any>;

// A raw trial shaped like a real Proven cell. No such trial exists yet; it keeps
// the proof gate from being vacuous while every committed cell is Blocked.
function rawTrial(shape: string, mode: string): Event[] {
  const hook = HOOKS[mode];
  const events: Event[] = [
    { kind: "session_start", at: "2026-10-01T10:00:00Z", startedBy: "user", ...(shape === "local_chat" ? { appPid: APP_PID } : {}) },
    ...(shape === "cloud_task" ? [{ kind: "task_created", at: "2026-10-01T09:59:00Z", createdBy: "user" }] : []),
    { kind: "trial_start", at: "2026-10-01T10:05:00Z" },
    {
      kind: "census",
      at: "2026-10-01T10:05:00.100Z",
      processes: [
        { pid: 1200, ppid: 1, argv: ["/usr/lib/systemd/systemd", "--user"] },
        ...(shape === "local_chat" ? [{ pid: APP_PID, ppid: 1200, argv: LAUNCH.local_chat }] : []),
      ],
    },
    { kind: "marker_scan", at: "2026-10-01T10:05:00.200Z", hits: [] },
    { kind: "tool_start", at: "2026-10-01T10:05:01Z" },
    { kind: "enqueue", at: "2026-10-01T10:05:05Z", batch: "b1", phase: "active" },
    { kind: "tool_complete", at: "2026-10-01T10:05:21Z" },
    { kind: "boundary", at: "2026-10-01T10:05:21.200Z", batch: "b1", hook },
    { kind: "model_context", at: "2026-10-01T10:05:22Z", batch: "b1" },
    { kind: "ack", at: "2026-10-01T10:05:30Z", batch: "b1" },
    { kind: "idle", at: "2026-10-01T10:06:00Z" },
    { kind: "enqueue", at: "2026-10-01T10:06:10Z", batch: "b2", phase: "idle" },
    { kind: "boundary", at: "2026-10-01T10:06:11Z", batch: "b2", hook },
    { kind: "model_context", at: "2026-10-01T10:06:12Z", batch: "b2" },
    { kind: "ack", at: "2026-10-01T10:06:20Z", batch: "b2" },
    { kind: "enqueue", at: "2026-10-01T10:07:00Z", batch: "b3", phase: "restart" },
    { kind: "boundary", at: "2026-10-01T10:07:01Z", batch: "b3", hook },
    { kind: "restart", at: "2026-10-01T10:07:05Z" },
    { kind: "boundary", at: "2026-10-01T10:07:30Z", batch: "b3", hook },
    { kind: "model_context", at: "2026-10-01T10:07:31Z", batch: "b3" },
    { kind: "ack", at: "2026-10-01T10:07:40Z", batch: "b3" },
  ];
  return events.map((event) => ({ sessionId: SESSION, appVersion: VERSION, launchCommand: LAUNCH[shape], ...event }));
}

type Trials = Record<string, Event[]>;

async function forge(edit: (record: any, trials: Trials) => void) {
  const dir = await mkdtemp(join(tmpdir(), "khala-codex-app-evidence-"));
  await cp("evidence", dir, { recursive: true });
  const path = join(dir, "cells.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  const trials: Trials = {};
  record.trials = trials;
  edit(record, trials);
  delete record.trials;
  await writeFile(path, `${JSON.stringify(record)}\n`);
  for (const [ref, events] of Object.entries(trials)) {
    await writeFile(join(dir, ref), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  }
  return dir;
}

const cell = (record: any, shape: string, mode: string) =>
  record.cells.find((item: any) => item.shape === shape && item.mode === mode);

function prove(record: any, shape: string, mode: string): Event[] {
  record.shapes[shape].appVersion = VERSION;
  const ref = `trial-${shape}-${mode}.jsonl`;
  const target = cell(record, shape, mode);
  Object.assign(target, { status: "proven", support: "proven", evidenceRef: ref });
  delete target.reason;
  delete target.inventoryFacts;
  record.trials[ref] = rawTrial(shape, mode);
  return record.trials[ref];
}

const kind = (events: Event[], name: string, batch?: string) =>
  events.find((event) => event.kind === name && (batch === undefined || event.batch === batch))!;

const addProcess = (events: Event[], proc: Event) => kind(events, "census").processes.push(proc);

const rejects = async (edit: (record: any) => void, message: RegExp) =>
  assert.rejects(verify(await forge(edit)), message);

test("the committed evidence verifies", async () => {
  await verify("evidence");
});

test("a well-formed proven trial passes the gate", async () => {
  await verify(await forge((record) => {
    prove(record, "local_chat", "steer");
    prove(record, "cloud_task", "sync");
    prove(record, "local_chat", "async");
  }));
});

test("the desktop app's own app-server backend passes", async () => {
  await verify(await forge((record) => {
    addProcess(prove(record, "local_chat", "sync"), { pid: 4200, ppid: APP_PID, argv: ["/opt/Codex/resources/codex", "app-server"] });
  }));
});

test("a missing cell is rejected", () => rejects((record) => {
  record.cells = record.cells.filter((item: any) => !(item.shape === "cloud_task" && item.mode === "async"));
}, /cell set/));

test("a blocked cell cannot claim support", () => rejects((record) => {
  cell(record, "local_chat", "sync").support = "unsupported";
}, /local_chat\/sync blocked cell must report unknown/));

test("a blocked reason must cite captured inventory", () => rejects((record) => {
  cell(record, "cloud_task", "steer").inventoryFacts = ["codex cloud list returned an existing task"];
}, /cloud_task\/steer inventory fact not captured/));

test("trial fields typed into cells.json are rejected", () => rejects((record) => {
  prove(record, "cloud_task", "async");
  cell(record, "cloud_task", "async").trial = { taskCreatedBy: "user" };
}, /cloud_task\/async carries trial fields in cells.json/));

test("starting codex app-server from Khala cannot satisfy delivery", () => rejects((record) => {
  const events = prove(record, "local_chat", "async");
  // Khala runs under the app (as its MCP server) and starts its own app server.
  addProcess(events, { pid: 5000, ppid: APP_PID, argv:["node", "/usr/lib/node_modules/@aiur/khala/dist/cli.js"] });
  addProcess(events, { pid: 5001, ppid: 5000, argv: ["codex", "app-server"] });
}, /local_chat\/async codex process started by Khala in census: codex app-server/));

test("an Agents API run Khala started under the app cannot satisfy delivery", () => rejects((record) => {
  const events = prove(record, "local_chat", "async");
  addProcess(events, { pid: 5000, ppid: APP_PID, argv: ["node", "/usr/lib/node_modules/@aiur/khala/dist/cli.js"] });
  addProcess(events, { pid: 5001, ppid: 5000, argv: ["node", "node_modules/@openai/agents/dist/run.js"] });
}, /local_chat\/async hosted model session in census: node node_modules\/@openai\/agents\/dist\/run.js/));

test("an app-server the desktop app did not start cannot satisfy delivery", () => rejects((record) => {
  addProcess(prove(record, "local_chat", "steer"), { pid: 5001, ppid: 1, argv: ["codex", "app-server"] });
}, /local_chat\/steer hosted model session in census/));

test("app-server behind a global option cannot satisfy delivery", () => rejects((record) => {
  addProcess(prove(record, "local_chat", "sync"), { pid: 5001, ppid: 1, argv: ["codex", "-c", "model=x", "app-server"] });
}, /local_chat\/sync hosted model session in census: codex -c model=x app-server/));

test("exec behind a profile option cannot satisfy delivery", () => rejects((record) => {
  addProcess(prove(record, "local_chat", "steer"), { pid: 5001, ppid: 1, argv: ["codex", "--profile", "khala", "exec", "hi"] });
}, /local_chat\/steer hosted model session in census: codex --profile khala exec hi/));

test("cloud exec behind a config option cannot satisfy delivery", () => rejects((record) => {
  addProcess(prove(record, "cloud_task", "steer"), { pid: 5001, ppid: 1, argv: ["codex", "cloud", "-c", "k=v", "exec", "hi"] });
}, /cloud_task\/steer hosted model session in census: codex cloud -c k=v exec hi/));

test("an Agents API run cannot satisfy delivery", () => rejects((record) => {
  addProcess(prove(record, "local_chat", "sync"), { pid: 5001, ppid: 1, argv: ["node", "node_modules/@openai/agents/dist/run.js"] });
}, /local_chat\/sync hosted model session in census/));

test("a new cloud task cannot satisfy delivery", () => rejects((record) => {
  kind(prove(record, "cloud_task", "steer"), "task_created").at = "2026-10-01T10:05:00.500Z";
}, /cloud_task\/steer cloud task created during the trial/));

test("a cloud task Khala submitted cannot satisfy delivery", () => rejects((record) => {
  kind(prove(record, "cloud_task", "async"), "task_created").createdBy = "khala";
}, /cloud_task\/async cloud task was not created by the user/));

test("a launch command that bypasses approvals cannot pass", () => rejects((record) => {
  for (const event of prove(record, "cloud_task", "sync")) {
    event.launchCommand = ["codex", "--dangerously-bypass-approvals-and-sandbox"];
  }
}, /cloud_task\/sync launch command bypasses normal trust settings: --dangerously-bypass-approvals-and-sandbox/));

test("a bypassed codex process in the census cannot pass", () => rejects((record) => {
  addProcess(prove(record, "local_chat", "steer"), {
    pid: 5001,
    ppid: APP_PID,
    argv: ["codex", "--dangerously-bypass-approvals-and-sandbox"],
  });
}, /local_chat\/steer census process bypasses normal trust settings/));

test("a launch command with --yolo cannot pass", () => rejects((record) => {
  for (const event of prove(record, "local_chat", "async")) event.launchCommand = ["codex", "--yolo"];
}, /local_chat\/async launch command bypasses normal trust settings: --yolo/));

test("a --yolo codex process in the census cannot pass", () => rejects((record) => {
  addProcess(prove(record, "cloud_task", "async"), { pid: 5001, ppid: APP_PID, argv: ["codex", "--yolo"] });
}, /cloud_task\/async census process bypasses normal trust settings: codex --yolo/));

test("a full-access sandbox cannot pass", () => rejects((record) => {
  addProcess(prove(record, "local_chat", "steer"), {
    pid: 5001,
    ppid: APP_PID,
    argv: ["codex", "-s", "danger-full-access"],
  });
}, /local_chat\/steer census process bypasses normal trust settings: codex -s danger-full-access/));

test("an attached full-access sandbox cannot pass", () => rejects((record) => {
  addProcess(prove(record, "local_chat", "steer"), { pid: 5001, ppid: APP_PID, argv: ["codex", "-sdanger-full-access"] });
}, /local_chat\/steer census process bypasses normal trust settings: codex -sdanger-full-access/));

test("approvals set to never cannot pass", () => rejects((record) => {
  for (const event of prove(record, "cloud_task", "steer")) {
    event.launchCommand = ["codex", "--ask-for-approval=never"];
  }
}, /cloud_task\/steer launch command bypasses normal trust settings: --ask-for-approval never/));

test("approvals disabled by a config override cannot pass", () => rejects((record) => {
  addProcess(prove(record, "local_chat", "sync"), {
    pid: 5001,
    ppid: APP_PID,
    argv: ["codex", "-c", "approval_policy=never"],
  });
}, /local_chat\/sync census process bypasses normal trust settings: codex -c approval_policy=never/));

test("sandbox disabled by a config override cannot pass", () => rejects((record) => {
  addProcess(prove(record, "local_chat", "sync"), {
    pid: 5001,
    ppid: APP_PID,
    argv: ["codex", "--config", 'sandbox_mode="danger-full-access"'],
  });
}, /local_chat\/sync census process bypasses normal trust settings/));

test("any codex process Khala started cannot pass", () => rejects((record) => {
  const events = prove(record, "local_chat", "steer");
  addProcess(events, { pid: 5000, ppid: APP_PID, argv: ["node", "/usr/lib/node_modules/@aiur/khala/dist/cli.js"] });
  addProcess(events, { pid: 5001, ppid: 5000, argv: ["codex", "resume", "--last"] });
}, /local_chat\/steer codex process started by Khala in census: codex resume --last/));

test("a plain codex prompt Khala started cannot pass", () => rejects((record) => {
  const events = prove(record, "cloud_task", "sync");
  addProcess(events, { pid: 5000, ppid: APP_PID, argv: ["node", "/usr/lib/node_modules/@aiur/khala/dist/cli.js"] });
  addProcess(events, { pid: 5001, ppid: 5000, argv: ["codex", "hi"] });
}, /cloud_task\/sync codex process started by Khala in census: codex hi/));

test("normal sandbox and approval options still pass", () => {
  assert.equal(trustBypass(["codex", "-s", "workspace-write", "-a", "on-request", "-c", "model=x"]), undefined);
});

test("a trial without the launch command cannot pass", () => rejects((record) => {
  for (const event of prove(record, "local_chat", "sync")) event.launchCommand = [];
}, /local_chat\/sync launch command not recorded/));

test("a launch command that is not the running app cannot pass", () => rejects((record) => {
  kind(prove(record, "local_chat", "async"), "session_start").appPid = 1200;
}, /local_chat\/async launch command is not the running app process/));

test("a hook that fired without model context cannot pass", () => rejects((record) => {
  const events = prove(record, "local_chat", "steer");
  events.splice(events.indexOf(kind(events, "model_context", "b1")), 1);
}, /local_chat\/steer model context timestamp missing/));

test("delivery into a different session cannot pass", () => rejects((record) => {
  kind(prove(record, "local_chat", "steer"), "model_context", "b1").sessionId = "0199ffff-0000-7000-8000-000000000000";
}, /local_chat\/steer model_context session differs/));

test("delivery through a different hook cannot pass", () => rejects((record) => {
  kind(prove(record, "local_chat", "steer"), "boundary", "b1").hook = "Stop";
}, /local_chat\/steer delivered through the wrong boundary/));

test("aborting the active tool cannot pass", () => rejects((record) => {
  kind(prove(record, "local_chat", "steer"), "boundary", "b1").at = "2026-10-01T10:05:10Z";
}, /local_chat\/steer delivered before the active tool completed/));

test("steer without an idle-session trial cannot pass", () => rejects((record) => {
  kind(prove(record, "local_chat", "steer"), "enqueue", "b2").phase = "restart";
}, /local_chat\/steer has no idle-session trial/));

test("sync without an idle-session trial cannot pass", () => rejects((record) => {
  kind(prove(record, "cloud_task", "sync"), "enqueue", "b2").phase = "restart";
}, /cloud_task\/sync has no idle-session trial/));

test("an idle batch enqueued before the session went idle cannot pass", () => rejects((record) => {
  kind(prove(record, "local_chat", "sync"), "idle").at = "2026-10-01T10:06:10.500Z";
}, /local_chat\/sync idle batch was not enqueued while the session sat idle/));

test("an idle batch delivered on a user's next turn cannot pass", () => rejects((record) => {
  const events = prove(record, "local_chat", "sync");
  events.push({ ...kind(events, "idle"), kind: "user_prompt", at: "2026-10-01T10:06:11.500Z" });
}, /local_chat\/sync session was not idle before the idle batch reached model context/));

test("a duplicate after restart cannot pass", () => rejects((record) => {
  const events = prove(record, "cloud_task", "sync");
  events.push({ ...kind(events, "boundary", "b1"), at: "2026-10-01T10:07:35Z" });
}, /cloud_task\/sync acknowledged batch delivered again after restart/));

test("a lost unacknowledged batch cannot pass", () => rejects((record) => {
  const events = prove(record, "local_chat", "sync");
  const replays = events.filter((event) => event.kind === "boundary" && event.batch === "b3");
  events.splice(events.indexOf(replays[replays.length - 1]), 1);
}, /local_chat\/sync unacknowledged batch not replayed/));

test("a proof for another app version cannot pass", () => rejects((record) => {
  kind(prove(record, "local_chat", "async"), "ack", "b1").appVersion = "26.901.0";
}, /local_chat\/async app version differs from the shape tuple/));

test("a message marker in argv cannot pass", () => rejects((record) => {
  kind(prove(record, "local_chat", "steer"), "marker_scan").hits.push({ argv: ["node", "hook.js", "K245-MARKER"] });
}, /local_chat\/steer marker found in a process argv/));
