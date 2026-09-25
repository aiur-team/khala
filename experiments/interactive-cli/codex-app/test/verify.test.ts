import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verify } from "../verify.ts";

const SESSION = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

// A trial shaped like a real Proven cell. No such trial exists yet; it keeps the
// proof gate from being vacuous while every committed cell is Blocked.
function provenTrial(shape: string) {
  return {
    appVersion: "26.925.0",
    sessionId: SESSION,
    sessionStartedBy: "user",
    sessionStartedAt: "2026-10-01T10:00:00Z",
    trialStartedAt: "2026-10-01T10:05:00Z",
    ...(shape === "cloud_task" ? { taskCreatedAt: "2026-10-01T09:59:00Z", taskCreatedBy: "user" } : {}),
    toolStartedAt: "2026-10-01T10:05:01Z",
    enqueuedAt: "2026-10-01T10:05:05Z",
    toolCompletedAt: "2026-10-01T10:05:21Z",
    boundaryAt: "2026-10-01T10:05:21.200Z",
    modelContextAt: "2026-10-01T10:05:22Z",
    acknowledgedAt: "2026-10-01T10:05:30Z",
    boundarySessionId: SESSION,
    contextSessionId: SESSION,
    ackSessionId: SESSION,
    restart: { replayedBeforeAck: true, deliveriesAfterAck: 0 },
    census: [{ argv: ["/opt/Codex/codex-desktop"] }],
    markerHits: [],
  };
}

async function forge(edit: (record: any) => void) {
  const dir = await mkdtemp(join(tmpdir(), "khala-codex-app-evidence-"));
  await cp("evidence", dir, { recursive: true });
  await writeFile(join(dir, "trial.jsonl"), "{}\n");
  const path = join(dir, "cells.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  edit(record);
  await writeFile(path, `${JSON.stringify(record)}\n`);
  return dir;
}

const cell = (record: any, shape: string, mode: string) =>
  record.cells.find((item: any) => item.shape === shape && item.mode === mode);

function prove(record: any, shape: string, mode: string) {
  record.shapes[shape].appVersion = "26.925.0";
  const target = cell(record, shape, mode);
  Object.assign(target, { status: "proven", support: "proven", evidenceRef: "trial.jsonl", trial: provenTrial(shape) });
  delete target.reason;
  delete target.inventoryFacts;
  return target.trial;
}

const rejects = async (edit: (record: any) => void, message: RegExp) =>
  assert.rejects(verify(await forge(edit)), message);

test("the committed evidence verifies", async () => {
  await verify("evidence");
});

test("a well-formed proven trial passes the gate", async () => {
  await verify(await forge((record) => {
    prove(record, "local_chat", "steer");
    prove(record, "cloud_task", "sync");
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

test("starting codex app-server cannot satisfy delivery", () => rejects((record) => {
  prove(record, "local_chat", "async").census.push({ argv: ["codex", "app-server", "daemon", "start"] });
}, /local_chat\/async hosted model session in census/));

test("an Agents API run cannot satisfy delivery", () => rejects((record) => {
  prove(record, "local_chat", "sync").census.push({ argv: ["node", "node_modules/@openai/agents/dist/run.js"] });
}, /local_chat\/sync hosted model session in census/));

test("a new cloud task cannot satisfy delivery", () => rejects((record) => {
  const trial = prove(record, "cloud_task", "steer");
  trial.taskCreatedAt = "2026-10-01T10:05:00.500Z";
}, /cloud_task\/steer cloud task created during the trial/));

test("a cloud task Khala submitted cannot satisfy delivery", () => rejects((record) => {
  prove(record, "cloud_task", "async").taskCreatedBy = "khala";
}, /cloud_task\/async cloud task was not created by the user/));

test("a hook that fired without model context cannot pass", () => rejects((record) => {
  prove(record, "local_chat", "steer").modelContextAt = null;
}, /local_chat\/steer model context timestamp missing/));

test("delivery into a different session cannot pass", () => rejects((record) => {
  prove(record, "local_chat", "steer").contextSessionId = "0199ffff-0000-7000-8000-000000000000";
}, /local_chat\/steer context session differs/));

test("aborting the active tool cannot pass", () => rejects((record) => {
  prove(record, "local_chat", "steer").boundaryAt = "2026-10-01T10:05:10Z";
}, /local_chat\/steer delivered before the active tool completed/));

test("a duplicate after restart cannot pass", () => rejects((record) => {
  prove(record, "cloud_task", "sync").restart.deliveriesAfterAck = 1;
}, /cloud_task\/sync acknowledged batch delivered again after restart/));

test("a lost unacknowledged batch cannot pass", () => rejects((record) => {
  prove(record, "local_chat", "sync").restart.replayedBeforeAck = false;
}, /local_chat\/sync unacknowledged batch not replayed/));

test("a proof for another app version cannot pass", () => rejects((record) => {
  prove(record, "local_chat", "async").appVersion = "26.901.0";
}, /local_chat\/async app version differs from the shape tuple/));

test("a message marker in argv cannot pass", () => rejects((record) => {
  prove(record, "local_chat", "steer").markerHits.push({ argv: ["node", "hook.js", "K245-MARKER"] });
}, /local_chat\/steer marker found in a process argv/));
