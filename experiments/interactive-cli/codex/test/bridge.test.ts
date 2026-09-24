import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const bridge = resolve("bridge.ts");

function run(root: string, command: string[], input?: unknown) {
  return spawnSync(process.execPath, [bridge, ...command], {
    cwd: resolve("."),
    env: { ...process.env, KHALA_FIXTURE_DIR: root },
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8"
  });
}

function runAsync(root: string, command: string[], input?: unknown): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [bridge, ...command], {
      cwd: resolve("."),
      env: { ...process.env, KHALA_FIXTURE_DIR: root }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "khala-codex-bridge-"));
}

test("steer delivers once at the next tool boundary and reoffers on a new turn", async () => {
  const root = await fixture();
  assert.equal(run(root, ["enqueue"], { mode: "steer", token: "s-1", body: "peer text" }).status, 0);

  const first = run(root, ["hook"], {
    hook_event_name: "PreToolUse", session_id: "session", turn_id: "turn-1", tool_name: "Bash"
  });
  assert.equal(first.status, 0);
  assert.equal(JSON.parse(first.stdout).decision, "block");
  assert.match(JSON.parse(first.stdout).reason, /peer text/);

  const duplicate = run(root, ["hook"], {
    hook_event_name: "PostToolUse", session_id: "session", turn_id: "turn-1", tool_name: "Bash"
  });
  assert.equal(duplicate.stdout, "");

  const nextTurn = run(root, ["hook"], {
    hook_event_name: "PreToolUse", session_id: "session", turn_id: "turn-2", tool_name: "Bash"
  });
  assert.equal(JSON.parse(nextTurn.stdout).decision, "block");
});

test("sync waits through PostToolUse and delivers at Stop", async () => {
  const root = await fixture();
  run(root, ["enqueue"], { mode: "sync", token: "y-1", body: "after the turn" });

  const post = run(root, ["hook"], {
    hook_event_name: "PostToolUse", session_id: "session", turn_id: "turn-1", tool_name: "Bash"
  });
  assert.equal(post.stdout, "");

  const stop = run(root, ["hook"], {
    hook_event_name: "Stop", session_id: "session", turn_id: "turn-1", stop_hook_active: false
  });
  assert.equal(JSON.parse(stop.stdout).decision, "block");
  assert.match(JSON.parse(stop.stdout).reason, /after the turn/);

  const guarded = run(root, ["hook"], {
    hook_event_name: "Stop", session_id: "session", turn_id: "turn-2", stop_hook_active: true
  });
  assert.equal(guarded.stdout, "");
});

test("sync can deliver an idle batch at the next prompt boundary", async () => {
  const root = await fixture();
  run(root, ["enqueue"], { mode: "sync", token: "y-idle", body: "after idle wake" });
  const prompt = run(root, ["hook"], {
    hook_event_name: "UserPromptSubmit", session_id: "session", turn_id: "turn-idle"
  });
  const output = JSON.parse(prompt.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /after idle wake/);
});

test("async remains silent until the agent explicitly reads", async () => {
  const root = await fixture();
  run(root, ["enqueue"], { mode: "async", token: "a-1", body: "on demand" });

  for (const hook_event_name of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    const hook = run(root, ["hook"], {
      hook_event_name, session_id: "session", turn_id: "turn-1", tool_name: "Bash", stop_hook_active: false
    });
    assert.equal(hook.stdout, "");
  }

  const read = run(root, ["read", "session", "turn-1"]);
  assert.deepEqual(JSON.parse(read.stdout), { messages: [{ token: "a-1", body: "on demand" }] });
  assert.deepEqual(JSON.parse(run(root, ["read", "session", "turn-1"]).stdout), { messages: [] });
  assert.deepEqual(JSON.parse(run(root, ["read", "session", "turn-2"]).stdout),
    { messages: [{ token: "a-1", body: "on demand" }] });
  assert.equal(run(root, ["ack", "a-1"]).status, 0);
  assert.deepEqual(JSON.parse(run(root, ["read", "session", "turn-3"]).stdout), { messages: [] });
});

test("hooks fail closed without session and turn identity", async () => {
  const root = await fixture();
  run(root, ["enqueue"], { mode: "steer", token: "s-2", body: "identified" });
  const hook = run(root, ["hook"], { hook_event_name: "PreToolUse", tool_name: "Bash" });
  assert.notEqual(hook.status, 0);
  assert.match(hook.stderr, /requires session_id and turn_id/);
});

test("acknowledgement is idempotent and retained on disk", async () => {
  const root = await fixture();
  run(root, ["enqueue"], { mode: "async", token: "a-2", body: "once" });
  assert.equal(run(root, ["ack", "a-2"]).status, 0);
  assert.equal(run(root, ["ack", "a-2"]).status, 0);

  const events = (await readFile(join(root, "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const acknowledgements = events.filter((event) => event.event === "acknowledged");
  assert.deepEqual(acknowledgements.map((event) => event.duplicate), [false, true]);
});

test("concurrent boundaries claim a batch only once", async () => {
  const root = await fixture();
  run(root, ["enqueue"], { mode: "steer", token: "s-race", body: "one offer" });
  const input = {
    hook_event_name: "PreToolUse", session_id: "session", turn_id: "turn-race", tool_name: "Bash"
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => runAsync(root, ["hook"], input)));
  assert.ok(results.every((result) => result.status === 0), results.map((result) => result.stderr).join("\n"));
  assert.equal(results.filter((result) => result.stdout !== "").length, 1);

  const events = (await readFile(join(root, "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.event === "delivered").length, 1);
});

test("concurrent acknowledgements preserve one durable transition", async () => {
  const root = await fixture();
  run(root, ["enqueue"], { mode: "async", token: "a-race", body: "ack once" });
  const results = await Promise.all(Array.from({ length: 8 }, () => runAsync(root, ["ack", "a-race"])));
  assert.ok(results.every((result) => result.status === 0), results.map((result) => result.stderr).join("\n"));

  const events = (await readFile(join(root, "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const acknowledgements = events.filter((event) => event.event === "acknowledged");
  assert.equal(acknowledgements.filter((event) => event.duplicate === false).length, 1);
  assert.equal(acknowledgements.filter((event) => event.duplicate === true).length, 7);
  assert.deepEqual(JSON.parse(run(root, ["read", "session", "turn-after-race"]).stdout), { messages: [] });
});

test("an acknowledgement racing a hook cannot resurrect the batch", async () => {
  const root = await fixture();
  run(root, ["enqueue"], { mode: "steer", token: "hook-ack-race", body: "race safely" });
  const [hook, ack] = await Promise.all([
    runAsync(root, ["hook"], {
      hook_event_name: "PreToolUse", session_id: "session", turn_id: "turn-race", tool_name: "Bash"
    }),
    runAsync(root, ["ack", "hook-ack-race"])
  ]);
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(ack.status, 0, ack.stderr);
  assert.deepEqual(JSON.parse(run(root, ["read", "session", "turn-after-race"]).stdout), { messages: [] });
});

test("an interrupted temporary write cannot replace committed state", async () => {
  const root = await fixture();
  run(root, ["enqueue"], { mode: "async", token: "committed", body: "keep me" });
  await writeFile(join(root, "inbox.json.crashed.new"), "{partial", { mode: 0o600 });
  const read = run(root, ["read", "session", "turn-after-crash"]);
  assert.deepEqual(JSON.parse(read.stdout), { messages: [{ token: "committed", body: "keep me" }] });
});
