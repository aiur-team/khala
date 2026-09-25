import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const verifier = resolve("verify.ts");

async function forge(edit: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "khala-codex-evidence-"));
  await cp("evidence", dir, { recursive: true });
  await edit(dir);
  return spawnSync(process.execPath, [verifier, join(dir, "live-run.json"), dir], { encoding: "utf8" });
}

async function editJson(path: string, change: (value: any) => void) {
  const value = JSON.parse(await readFile(path, "utf8"));
  change(value);
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

test("the committed evidence verifies", () => {
  const result = spawnSync(process.execPath, [verifier], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("a summary not backed by a raw arrival is rejected", async () => {
  const result = await forge((dir) => editJson(join(dir, "live-run.json"), (summary) => {
    summary.proofs[0].token = "forged-token";
  }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /0\.154\.0 steer raw arrival missing/);
});

test("a steer proof without a tool start before arrival is rejected", async () => {
  const result = await forge((dir) => editJson(join(dir, "live-run.json"), (summary) => {
    summary.proofs[0].toolStartAt = summary.proofs[0].arrivedAt;
  }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tool start missing/);
});

test("a delivery the model never saw is rejected", async () => {
  const result = await forge(async (dir) => {
    const rows = (await readFile(join(dir, "rollout-excerpts.jsonl"), "utf8")).trim().split("\n")
      .filter((line) => !line.includes("steer-0156-r2"));
    await writeFile(join(dir, "rollout-excerpts.jsonl"), `${rows.join("\n")}\n`);
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /0\.156\.1 steer model context missing/);
});

test("an event without session identity is rejected", async () => {
  const result = await forge(async (dir) => {
    const path = join(dir, "events-0.156.1.jsonl");
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    delete lines.find((event) => event.event === "delivered").sessionId;
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /session/);
});

test("a marker captured in a live process argv is rejected", async () => {
  const result = await forge((dir) => editJson(join(dir, "proc-0.154.0.json"), (proc) => {
    proc.markerHits = [{ kind: "hook", commandLine: ["node", "bridge.ts", "K164M-STEER-0154-QX71"] }];
  }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /marker found in a process argv or environment/);
});
