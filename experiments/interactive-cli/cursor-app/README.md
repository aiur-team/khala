# Cursor app proof

This throwaway kit and verifier back the Cursor rows of
[`interactive-desktop-apps.md`](../../../docs/product/internal-mode/interactive-desktop-apps.md).

## Result

Every Cursor cell is **Blocked** (`status: "unknown"`). Cursor is not installed on
the proof host and no Cursor account is signed in
([`evidence/host-inventory.txt`](./evidence/host-inventory.txt)). No exact version,
account tier, or administrator policy exists to key a trial, and there is no existing
cloud agent to attach to. The agent did not install Cursor, sign in, open a chat, or
create a cloud agent, because Khala never launches or hosts an agent (decision 24).
[`evidence/matrix.json`](./evidence/matrix.json) is the verifier's output for the
retained evidence. `blocked.json` gives the reason for each shape.

## What is here

- `kit/` holds what a person installs into their own scratch Cursor project:
  - project `.cursor/hooks.json` entries for `sessionStart`, `preToolUse`,
    `postToolUse`, `beforeMCPExecution`, and `stop`;
  - one hook script, `hook.mjs`;
  - a stdio MCP server exposing `khala_read` and `khala_status`.

  The Khala side of the contract is the [Claude proof's store](../claude/marketplace/plugins/khala-proof/lib/store.mjs):
  - batch tokens, generation fencing, and acknowledgement on the next agent call;
  - bodies logged only as byte counts and SHA-256;
  - raw tokens never reach the model or the log.
- `verify.mjs` grades trial directories into the per-shape matrix.
- `cursor-proof.test.mjs` drives the kit with Cursor-shaped input and checks the verifier. Its trials are synthetic fixtures, never evidence.

Cursor-specific design points the live trial must confirm:

- **Session identity.** A resumed chat keeps its `conversation_id` after an app
  restart. `sessionStart` therefore returns its `session_id` as the session-scoped
  env `KHALA_CURSOR_SESSION`. The binding key is `conversation_id/session_id`, so
  every restart fences unacknowledged tokens and replays them.
- **Background agents.** A `sessionStart` with `is_background_agent: true` never binds.
- **Cloud binding.** Cloud agents run no `sessionStart` hook, so a `cloud_task` run
  binds on its first hook.
- **MCP caller identity.** Cursor gives an MCP server no chat identity. The
  `beforeMCPExecution` hook records the caller, and the next `khala_*` call claims
  that record within 10 s. Without the record the call fails closed. The hook
  returns no permission decision, so Cursor's normal MCP approval applies
  (decision 33).
- **`sync` follow-ups.** `stop` sends at most one `followup_message` per human turn:
  - `loop_count > 0` returns control to the person, and `loop_limit: 1` backs this up;
  - an `aborted` or `error` turn never resumes.

  `sync` delivers only at the end of a turn. An idle chat receives nothing until the
  person's next turn ends, and this kit claims no idle wake.

## The verifier

A cell becomes `proven` only when a single trial of that shape passes every check
below. Anything less leaves the cell `unknown` with the failed checks as its reason.

- **Identity.** The trial's version, account tier, and policy are exact values, and
  every hook reported that same `cursor_version`.
- **Session census.** There is exactly one Cursor conversation. No background agent,
  cloud agent, or Khala-started model process exists.
- **Boundary.** Every release happened at the mode's boundary: `postToolUse`,
  `stop`, or `khala_read`.
- **`steer` timing.** For `steer`, the batch arrived while a completed tool of at
  least 20 s was running.
- **Model context.** A transcript sighting of the released nonce appears in the
  same conversation after the release.
- **Acknowledgement.** Acknowledgement came from a later `khala_read` or
  `khala_status` call, never from a hook.
- **Replay.** A restart between fetch and acknowledgement replayed the batch.
- **No duplicates.** No release was acknowledged twice or delivered after
  acknowledgement.
- **No leaked tokens.** No raw `bt_` token appears in the event log.

## Running a trial (a person, in their own Cursor)

```sh
state=$(node experiments/interactive-cli/cursor-app/kit/install.mjs <project> <run-id> local_chat "<Cursor version>" <tier> <policy>)
node experiments/interactive-cli/claude/khala-admin.mjs mode "$state" steer   # or sync / async
```

1. Open `<project>` in Cursor with normal trust settings and start Agent Chat yourself.
2. Ask for `sleep 25`.
3. While it runs, from another terminal:

   ```sh
   printf 'KHALA-NONCE-<hex>' | node experiments/interactive-cli/claude/khala-admin.mjs release "$state"
   ```

4. Ask the agent to repeat any Khala nonce it sees.
5. Quit and reopen Cursor before the agent makes a `khala_*` call, then resume the
   chat, so the batch replays.
6. Ask for `khala_status`.
7. Restart once more and confirm nothing is delivered again.

To record the trial, copy `"$state"` to `evidence/trials/<run-id>/`. Add
`observations.json` containing:

- `census`: counts of `backgroundAgentsCreated`, `cloudAgentsCreated`, and
  `khalaStartedModelProcesses`;
- `modelContext`: each sighting's `conversationId`, the nonce `sha256`, and
  `observedAt`, taken from the chat transcript.

Then regenerate the matrix:

```sh
node experiments/interactive-cli/cursor-app/verify.mjs experiments/interactive-cli/cursor-app/evidence > experiments/interactive-cli/cursor-app/evidence/matrix.json
```

For a cloud agent, commit `kit/` and a `.cursor/hooks.json` with repository-relative
paths into that agent's existing repository. Record the run with shape `cloud_task`.
Never create a new cloud agent for the trial.

## Validation

```sh
node --test experiments/interactive-cli/cursor-app/cursor-proof.test.mjs
node experiments/interactive-cli/cursor-app/verify.mjs experiments/interactive-cli/cursor-app/evidence --check
```
