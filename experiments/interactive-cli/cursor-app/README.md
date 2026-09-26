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
  - project `.cursor/hooks.json` entries for `sessionStart`, `beforeSubmitPrompt`,
    `preToolUse`, `postToolUse`, `beforeMCPExecution`, and `stop`;
  - one hook script, `hook.mjs`;
  - a stdio MCP server exposing `khala_read` and `khala_status`;
  - `record-launch.mjs`, which records the running Cursor app process (argv and
    parent chain) and the trust settings. It launches nothing;
  - `census.mjs`, which captures the raw process list (pid, parent pid, argv).

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
  person's next turn ends, and this kit claims no idle wake. Because decisions 34 and
  37 require idle delivery, a trial run with this kit cannot prove `steer` or `sync`.

## The verifier

A cell becomes `proven` only when a single trial of that shape passes every check
below. Anything less leaves the cell `unknown` with the failed checks as its reason.

- **Identity.** The trial's version, account tier, and policy are exact values, and
  every hook reported that same `cursor_version`.
- **Session census.** Every census fact comes from the raw process list in
  `census.json`, taken during the trial, never from typed counts. Any process with
  a Cursor or `cursor-agent` token anywhere in its argv counts, including
  `node …/cursor-agent/…/index.js`. Such a process fails the trial if its parent is
  missing from the census, it has a Khala ancestor, it runs headless
  (`-p`/`--print`), or it carries a bypass flag (`--force`, `--yolo`,
  `--approve-mcps`, `--trust`, `--sandbox disabled`). Combined short flags such as
  `-pf` are split before these checks. Hooks saw exactly one Cursor
  conversation, and no background agent session.
- **Launch and trust (decision 33).** `launch.json` records the running Cursor
  desktop app process before the first batch arrives. For `local_chat` that is only
  the app binary itself: never `cursor-agent`, `cursor agent`, or an Electron helper
  process. That process is in the census with the same argv. It has no Khala ancestor and no bypass flag. Every event carries that
  launch command. Agent auto-run is `ask`, `allowlist`, or `sandbox`, never
  `run-everything`, and MCP auto-run is `off`. A cloud trial names an existing cloud
  agent created before the trial.
- **Boundary.** Every release happened at the mode's boundary: `postToolUse`,
  `stop`, or `khala_read`.
- **`steer` timing.** For `steer`, the batch arrived while a completed tool of at
  least 20 s was running.
- **Model context.** A transcript sighting of the released nonce appears in the
  same conversation after the release.
- **Acknowledgement.** Acknowledgement came from a later `khala_read` or
  `khala_status` call, never from a hook.
- **Replay.** A restart between fetch and acknowledgement replayed the batch.
- **Idle delivery (`steer` and `sync`, decisions 34 and 37).** A batch that arrived
  after the chat's turn ended reached model context before any new prompt or tool
  call, and a later agent call acknowledged it.
- **No duplicates.** No release was acknowledged twice or delivered after
  acknowledgement.
- **No leaked tokens.** No raw `bt_` token appears in the event log.

## Running a trial (a person, in their own Cursor)

```sh
state=$(node experiments/interactive-cli/cursor-app/kit/install.mjs <project> <run-id> local_chat "<Cursor version>" <tier> <policy>)
node experiments/interactive-cli/claude/khala-admin.mjs mode "$state" steer   # or sync / async
```

1. Open `<project>` in Cursor yourself, with your normal trust settings. Before you
   start Agent Chat, record the launch. Pass the Cursor app's main process ID and the
   settings shown under Cursor Settings → Agents:

   ```sh
   node experiments/interactive-cli/cursor-app/kit/record-launch.mjs "$state" --app-pid <pid> --auto-run <ask|allowlist|sandbox|run-everything> --mcp-auto-run <on|off>
   ```

2. Start Agent Chat and ask for `sleep 25`.
3. While it runs, from another terminal:

   ```sh
   printf 'KHALA-NONCE-<hex>' | node experiments/interactive-cli/claude/khala-admin.mjs release "$state"
   node experiments/interactive-cli/cursor-app/kit/census.mjs "$state"
   ```

4. Ask the agent to repeat any Khala nonce it sees.
5. Quit Cursor before the agent makes a `khala_*` call. Reopen it the same way, then
   resume the chat so the batch replays.
6. Ask for `khala_status`.
7. Restart once more and confirm nothing is delivered again.

To record the trial, copy `"$state"` to `evidence/trials/<run-id>/`. Add
`observations.json` whose `modelContext` lists each sighting's `conversationId`,
nonce `sha256`, and `observedAt`, taken from the chat transcript.

Then regenerate the matrix:

```sh
node experiments/interactive-cli/cursor-app/verify.mjs experiments/interactive-cli/cursor-app/evidence > experiments/interactive-cli/cursor-app/evidence/matrix.json
```

For a cloud agent, commit `kit/` and a `.cursor/hooks.json` with repository-relative
paths into that agent's existing repository. Record the run with shape `cloud_task`,
and record the launch with `--cloud-agent <id> --cloud-created-at <iso>` in place of
`--app-pid`. Never create a new cloud agent for the trial.

## Validation

```sh
node --test experiments/interactive-cli/cursor-app/cursor-proof.test.mjs
node experiments/interactive-cli/cursor-app/verify.mjs experiments/interactive-cli/cursor-app/evidence --check
```
