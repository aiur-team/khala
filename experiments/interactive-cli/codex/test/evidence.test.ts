import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const verifier = resolve("verify.ts");

test("evidence verifier rejects a summary not backed by raw events", async () => {
  const root = await mkdtemp(join(tmpdir(), "khala-codex-evidence-"));
  const summary = JSON.parse(await readFile("evidence/live-run.json", "utf8"));
  summary.proofs[0].token = "forged-token";
  const forged = join(root, "forged-live-run.json");
  await writeFile(forged, `${JSON.stringify(summary)}\n`);

  const result = spawnSync(process.execPath, [verifier, forged], {
    cwd: resolve("."),
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /raw arrival missing for 0\.154\.0 steer/);
});

test("evidence verifier rejects a marker captured in process argv", async () => {
  const root = await mkdtemp(join(tmpdir(), "khala-codex-argv-evidence-"));
  const safety = JSON.parse(await readFile("evidence/argv-safety.json", "utf8"));
  safety.commandLineMarkerMatches = [safety.marker];
  const forged = join(root, "forged-argv-safety.json");
  await writeFile(forged, `${JSON.stringify(safety)}\n`);

  const result = spawnSync(process.execPath, [verifier, "evidence/live-run.json", forged], {
    cwd: resolve("."),
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected values to be strictly deep-equal/);
});
