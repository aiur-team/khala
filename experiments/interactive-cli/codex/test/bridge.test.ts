import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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

test("async remains silent until the agent explicitly reads", async () => {
  const root = await fixture();
  run(root, ["enqueue"], { mode: "async", token: "a-1", body: "on demand" });

  for (const hook_event_name of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    const hook = run(root, ["hook"], {
      hook_event_name, session_id: "session", turn_id: "turn-1", tool_name: "Bash", stop_hook_active: false
    });
    assert.equal(hook.stdout, "");
  }

  const read = run(root, ["read"]);
  assert.deepEqual(JSON.parse(read.stdout), { messages: [{ token: "a-1", body: "on demand" }] });
  assert.equal(run(root, ["ack", "a-1"]).status, 0);
  assert.deepEqual(JSON.parse(run(root, ["read"]).stdout), { messages: [] });
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
