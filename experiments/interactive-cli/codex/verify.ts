import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type Event = Record<string, unknown> & { at: string; event: string };

const [summaryPath = "evidence/live-run.json", evidenceDir = "evidence"] = process.argv.slice(2);
const summary = JSON.parse(await readFile(summaryPath, "utf8"));
const jsonl = async (name: string) => (await readFile(join(evidenceDir, name), "utf8"))
  .trim().split("\n").map((line) => JSON.parse(line));
const rollout = await jsonl("rollout-excerpts.jsonl");

assert.deepEqual(summary.versions, ["0.154.0", "0.156.1"]);
const cells = ["steer", "sync", "async", "idle-wake-sync", "idle-wake-steer", "restart"];

for (const version of summary.versions as string[]) {
  const events: Event[] = await jsonl(`events-${version}.jsonl`);
  const cliVersion = `codex-cli ${version}`;

  // Hooks run outside Codex's sandbox and record their own identity.
  const hookIdentity = (event: Event, label: string) => {
    assert.equal(event.codexVersion, cliVersion, `${label} version`);
    assert.ok(Array.isArray(event.codexArgv) && event.codexArgv.length > 0, `${label} launch`);
    assert.match(String(event.sessionId), /^[0-9a-f-]{36}$/, `${label} session`);
    assert.match(String(event.turnId), /^[0-9a-f-]{36}$/, `${label} turn`);
  };
  for (const event of events.filter((item) => item.event === "hook" || item.event === "delivered")) {
    hookIdentity(event, `${version} ${event.event}@${event.at}`);
  }
  // The agent's Khala calls run inside Codex's sandbox, in a separate PID
  // namespace, so they carry the session from CODEX_THREAD_ID. Their turn,
  // version, and launch come from the PreToolUse hook that Codex ran for that
  // exact command moments earlier.
  for (const event of events.filter((item) => item.event === "agent_read" || item.event === "acknowledged")) {
    const label = `${version} ${event.event}@${event.at}`;
    assert.match(String(event.sessionId), /^[0-9a-f-]{36}$/, `${label} session`);
    const call = events.filter((item) => item.event === "hook" && item.hookEvent === "PreToolUse" &&
      item.sessionId === event.sessionId && String(item.toolCommand).startsWith("KHALA_FIXTURE_DIR=") &&
      Date.parse(item.at) <= Date.parse(event.at) && Date.parse(event.at) - Date.parse(item.at) < 1_000).at(-1);
    assert.ok(call, `${label} has no PreToolUse hook for the Khala call`);
    hookIdentity(call, `${label} via PreToolUse@${call.at}`);
  }

  const find = (predicate: (event: Event) => boolean, label: string) => {
    const found = events.find(predicate);
    assert.ok(found, `${version} ${label}`);
    return found;
  };

  for (const cell of cells) {
    const proof = summary.proofs.find((item: { version: string; cell: string }) =>
      item.version === version && item.cell === cell);
    assert.ok(proof, `missing ${version} ${cell}`);
    assert.equal(proof.status, "Proven");
    const label = `${version} ${cell}`;
    const token = proof.token;

    find((event) => event.event === "batch_arrived" && event.token === token && event.at === proof.arrivedAt,
      `${cell} raw arrival missing`);

    if (cell === "async") {
      const read = find((event) => event.event === "agent_read" && event.token === token && event.at === proof.observedAt,
        `${cell} explicit read missing`);
      assert.equal(read.sessionId, proof.sessionId);
      assert.ok(!events.some((event) => event.event === "delivered" && event.token === token), `${label} hook delivered`);
    } else {
      const delivered = find((event) => event.event === "delivered" && event.token === token &&
        event.at === proof.observedAt, `${cell} raw delivery missing`);
      assert.equal(delivered.route, proof.route);
      assert.equal(delivered.sessionId, proof.sessionId);
      assert.equal(delivered.turnId, proof.turnId);
    }
    assert.ok(Date.parse(proof.arrivedAt) <= Date.parse(proof.observedAt), `${label} observed before arrival`);

    if (proof.toolStartAt) {
      const start = find((event) => event.event === "hook" && event.hookEvent === "PreToolUse" &&
        event.at === proof.toolStartAt && String(event.toolCommand).includes("sleep 20"), `${cell} tool start missing`);
      assert.equal(start.turnId, proof.turnId);
      assert.ok(Date.parse(proof.toolStartAt) < Date.parse(proof.arrivedAt), `${label} arrived before the tool`);
      const toolEnd = events.find((event) => event.event === "hook" && event.hookEvent === "PostToolUse" &&
        event.turnId === proof.turnId && event.toolCommand === start.toolCommand);
      assert.ok(toolEnd && Date.parse(proof.arrivedAt) < Date.parse(toolEnd.at), `${label} arrived after the tool ended`);
    }

    for (const silent of proof.silentAt ?? []) {
      const [hookEvent, at] = silent.split("@");
      find((event) => event.event === "hook" && event.hookEvent === hookEvent && event.at === at &&
        event.token === token && event.pending === true, `${cell} silent ${silent} missing`);
      assert.ok(Date.parse(at) < Date.parse(proof.observedAt), `${label} silent hook after delivery`);
    }

    if (proof.wakeAt) {
      const wake = find((event) => event.event === "driver" && event.step === "wake_sent" && event.token === token &&
        event.at === proof.wakeAt, `${cell} wake missing`);
      assert.equal(wake.status, 0);
    }

    if (cell === "restart") {
      const offers = events.filter((event) => event.event === "delivered" && event.token === token);
      assert.equal(offers.length, 2, `${label} expected one offer before and one after the restart`);
      assert.equal(offers[0].at, proof.firstOfferAt);
      find((event) => event.event === "driver" && event.step === "codex_killed_after_offer" && event.token === token &&
        event.at === proof.killedAt, `${cell} kill missing`);
      assert.ok(!events.some((event) => event.event === "acknowledged" && event.token === token &&
        Date.parse(event.at) < Date.parse(proof.killedAt)), `${label} acknowledged before the kill`);
      for (const silent of proof.afterAckSilentAt) {
        const [hookEvent, at] = silent.split("@");
        find((event) => event.event === "hook" && event.hookEvent === hookEvent && event.at === at &&
          event.token === token && event.pending === false, `${cell} post-ack ${silent} missing`);
        assert.ok(Date.parse(at) > Date.parse(proof.acknowledgedAt));
      }
    }

    const acks = events.filter((event) => event.event === "acknowledged" && event.token === token);
    assert.equal(acks.length, 1, `${label} expected exactly one acknowledgement`);
    assert.equal(acks[0].at, proof.acknowledgedAt);
    assert.equal(acks[0].duplicate, false);
    assert.equal(acks[0].sessionId, proof.sessionId);

    const context = rollout.find((row) => row.kind === "entered_model_context" && row.session === proof.sessionId &&
      row.at === proof.contextAt);
    assert.ok(context, `${label} model context missing`);
    const relayed = rollout.find((row) => row.kind === "relayed_by_model" && row.session === proof.sessionId &&
      row.at === proof.relayedAt && row.marker === context.marker);
    assert.ok(relayed, `${label} relay missing`);
    assert.ok(Date.parse(proof.observedAt) <= Date.parse(proof.contextAt));
    assert.ok(Date.parse(proof.acknowledgedAt) <= Date.parse(proof.relayedAt));
  }

  const proc = JSON.parse(await readFile(join(evidenceDir, `proc-${version}.json`), "utf8"));
  assert.deepEqual(proc.markerHits, [], `${version} marker found in a process argv or environment`);
  assert.ok(proc.processCounts.hook > 0 && proc.processCounts.read > 0 && proc.processCounts["queue-wake"] > 0,
    `${version} process capture missed live hook, read, or wake processes`);
}

for (const row of rollout.filter((item) => item.kind === "session_meta")) {
  assert.equal(row.originator, "codex-tui");
}
assert.equal(summary.safety.hardAbortEnabled, false);
console.log(`verified ${summary.proofs.length} live proofs and process captures`);
