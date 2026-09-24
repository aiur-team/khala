import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) throw new Error("usage: verify.ts <live-run.json>");
const evidence = JSON.parse(await readFile(path, "utf8"));

assert.deepEqual(evidence.versions, ["0.154.0", "0.156.1"]);
for (const version of evidence.versions) {
  for (const mode of ["steer", "sync", "async"]) {
    const proof = evidence.proofs.find((item: { version: string; mode: string }) =>
      item.version === version && item.mode === mode);
    assert.ok(proof, `missing ${version} ${mode}`);
    assert.equal(proof.status, "Proven");
    assert.match(proof.arrivedAt, /^2026-/);
    assert.match(proof.observedAt, /^2026-/);
  }
}

assert.equal(evidence.safety.messageBytesInArgv, false);
assert.equal(evidence.safety.hardAbortEnabled, false);
assert.equal(evidence.safety.acknowledgement, "batch token");
console.log("verified 6 live mode proofs and safety assertions");
