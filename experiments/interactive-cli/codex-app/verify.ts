import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Checks the Codex app proof record. A Blocked cell must stay `unknown` and cite
// facts that appear verbatim in the host inventory. A Proven cell must carry
// same-session boundary timing, model-context, restart, and acknowledgement
// evidence from the user's existing session, and never a Khala-started one.

const SHAPES = ["local_chat", "cloud_task"] as const;
const BOUNDARIES: Record<string, string> = { steer: "PostToolUse", sync: "Stop", async: "khala_read" };

// A second model session in place of the user's: an app server, a headless run,
// a newly submitted cloud task, or an Agents API/SDK run.
const HOSTED_SESSION = [
  /\bcodex(?:\.js)?\s+(?:app-server|exec|e|cloud\s+exec|remote-control)\b/,
  /\/v1\/(?:responses|agents)\b/,
  /@openai\/agents\b|\bopenai-agents\b/,
];

type Trial = {
  appVersion: string;
  sessionId: string;
  sessionStartedBy: string;
  sessionStartedAt: string;
  trialStartedAt: string;
  taskCreatedAt?: string;
  taskCreatedBy?: string;
  toolStartedAt: string;
  enqueuedAt: string;
  toolCompletedAt: string;
  boundaryAt: string;
  modelContextAt: string | null;
  acknowledgedAt: string;
  boundarySessionId: string;
  contextSessionId: string;
  ackSessionId: string;
  restart: { replayedBeforeAck: boolean; deliveriesAfterAck: number };
  census: { argv: string[] }[];
  markerHits: unknown[];
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
  trial?: Trial;
};

const at = (value: string | null | undefined, label: string) => {
  const ms = Date.parse(String(value));
  assert.ok(Number.isFinite(ms), `${label} timestamp missing`);
  return ms;
};

function verifyBlocked(cell: Cell, label: string, inventory: string) {
  // Nothing was inspected in a live session, so this is not a proven negative.
  assert.equal(cell.support, "unknown", `${label} blocked cell must report unknown`);
  assert.equal(cell.evidenceRef, null, `${label} blocked cell must not cite evidence`);
  assert.equal(cell.trial, undefined, `${label} blocked cell must not carry a trial`);
  assert.ok((cell.reason ?? "").trim().length > 0, `${label} blocked reason missing`);
  assert.ok((cell.inventoryFacts ?? []).length > 0, `${label} blocked reason cites no inventory fact`);
  for (const fact of cell.inventoryFacts ?? []) {
    assert.ok(inventory.includes(fact), `${label} inventory fact not captured: ${fact}`);
  }
}

async function verifyProven(cell: Cell, label: string, shapeVersion: string | null, dir: string) {
  const t = cell.trial;
  assert.ok(t, `${label} proven cell has no trial`);
  assert.equal(cell.support, "proven", `${label} proven cell must report proven`);
  assert.ok(cell.evidenceRef, `${label} proven cell has no evidence reference`);
  await access(join(dir, cell.evidenceRef)).catch(() => assert.fail(`${label} evidence file missing`));
  assert.ok(shapeVersion, `${label} shape has no exact app version`);
  assert.equal(t.appVersion, shapeVersion, `${label} app version differs from the shape tuple`);

  // Same session: the user started it before the trial, and every observation
  // names it.
  assert.equal(t.sessionStartedBy, "user", `${label} session was not started by the user`);
  const trialStart = at(t.trialStartedAt, `${label} trial start`);
  assert.ok(at(t.sessionStartedAt, `${label} session start`) < trialStart, `${label} session started during the trial`);
  if (cell.shape === "cloud_task") {
    assert.equal(t.taskCreatedBy, "user", `${label} cloud task was not created by the user`);
    assert.ok(at(t.taskCreatedAt, `${label} task creation`) < trialStart, `${label} cloud task created during the trial`);
  }
  for (const [field, id] of [["boundary", t.boundarySessionId], ["context", t.contextSessionId], ["ack", t.ackSessionId]]) {
    assert.equal(id, t.sessionId, `${label} ${field} session differs from the user's session`);
  }
  for (const proc of t.census) {
    const argv = proc.argv.join(" ");
    for (const pattern of HOSTED_SESSION) {
      assert.ok(!pattern.test(argv), `${label} hosted model session in census: ${argv}`);
    }
  }
  assert.equal(t.markerHits.length, 0, `${label} marker found in a process argv or environment`);

  // Boundary timing. Delivery must also reach the model: a hook firing alone is
  // only a transport receipt.
  const toolStart = at(t.toolStartedAt, `${label} tool start`);
  const enqueued = at(t.enqueuedAt, `${label} enqueue`);
  const toolDone = at(t.toolCompletedAt, `${label} tool completion`);
  const boundary = at(t.boundaryAt, `${label} boundary`);
  const context = at(t.modelContextAt, `${label} model context`);
  const ack = at(t.acknowledgedAt, `${label} acknowledgement`);
  if (cell.mode === "steer") {
    assert.ok(toolStart < enqueued && enqueued < toolDone, `${label} steer batch not enqueued during the tool`);
  }
  assert.ok(enqueued <= boundary, `${label} boundary before enqueue`);
  if (cell.mode !== "async") {
    assert.ok(toolDone <= boundary, `${label} delivered before the active tool completed`);
  }
  assert.ok(boundary <= context, `${label} model context before the boundary`);
  assert.ok(context <= ack, `${label} acknowledged before model context`);

  assert.equal(t.restart.replayedBeforeAck, true, `${label} unacknowledged batch not replayed after restart`);
  assert.equal(t.restart.deliveriesAfterAck, 0, `${label} acknowledged batch delivered again after restart`);
}

export async function verify(dir: string) {
  const record = JSON.parse(await readFile(join(dir, "cells.json"), "utf8"));
  const inventory = await readFile(join(dir, record.inventory), "utf8");
  const cells: Cell[] = record.cells;
  const expected = SHAPES.flatMap((shape) => Object.keys(BOUNDARIES).map((mode) => `${shape}/${mode}`));
  assert.deepEqual(cells.map((cell) => `${cell.shape}/${cell.mode}`).sort(), expected.sort(), "cell set");

  for (const cell of cells) {
    const label = `${cell.shape}/${cell.mode}`;
    assert.equal(cell.boundary, BOUNDARIES[cell.mode], `${label} boundary`);
    if (cell.status === "blocked") verifyBlocked(cell, label, inventory);
    else if (cell.status === "proven") await verifyProven(cell, label, record.shapes[cell.shape]?.appVersion ?? null, dir);
    else assert.fail(`${label} status must be blocked or proven`);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await verify(process.argv[2] ?? "evidence");
  console.log("codex-app evidence verified");
}
