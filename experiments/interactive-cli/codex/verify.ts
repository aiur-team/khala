import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [path, argvEvidencePath = "evidence/argv-safety.json"] = process.argv.slice(2);
if (!path) throw new Error("usage: verify.ts <live-run.json> [argv-safety.json]");
const evidence = JSON.parse(await readFile(path, "utf8"));
const installedEvents = (await readFile("evidence/installed-0.154.0.jsonl", "utf8"))
  .trim().split("\n").map((line) => JSON.parse(line));
const latestEvents = (await readFile("evidence/latest-0.156.1.jsonl", "utf8"))
  .trim().split("\n").map((line) => JSON.parse(line));

assert.deepEqual(evidence.versions, ["0.154.0", "0.156.1"]);
for (const version of evidence.versions) {
  for (const mode of ["steer", "sync", "async"]) {
    const proof = evidence.proofs.find((item: { version: string; mode: string }) =>
      item.version === version && item.mode === mode);
    assert.ok(proof, `missing ${version} ${mode}`);
    assert.equal(proof.status, "Proven");
    assert.match(proof.arrivedAt, /^2026-/);
    assert.match(proof.observedAt, /^2026-/);
    const events = version === "0.154.0" ? installedEvents : latestEvents;
    const arrival = events.find((event) => event.event === "batch_arrived" &&
      event.token === proof.token && event.at === proof.arrivedAt && event.mode === mode);
    assert.ok(arrival, `raw arrival missing for ${version} ${mode}`);
    const observedEvent = mode === "async" ? "agent_read" : "delivered";
    const observed = events.find((event) => event.event === observedEvent &&
      event.token === proof.token && event.at === proof.observedAt);
    assert.ok(observed, `raw observation missing for ${version} ${mode}`);
    if (mode !== "async") assert.equal(observed.route, proof.route);
    if (proof.acknowledgedAt) {
      assert.ok(events.find((event) => event.event === "acknowledged" &&
        event.token === proof.token && event.at === proof.acknowledgedAt));
    }
    assert.ok(Date.parse(proof.arrivedAt) <= Date.parse(proof.observedAt));
  }
}

const argvEvidence = JSON.parse(await readFile(argvEvidencePath, "utf8"));
assert.deepEqual(argvEvidence.commandLineMarkerMatches, []);
assert.deepEqual(argvEvidence.environmentMarkerMatches, []);
assert.equal(argvEvidence.messageTransport, "stdin pipe");
assert.equal(evidence.safety.hardAbortEnabled, false);
assert.equal(evidence.safety.acknowledgement, "batch token");
console.log("verified 6 live mode proofs and safety assertions");
