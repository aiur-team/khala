# OpenCode interactive-CLI proof

This directory holds the throwaway OpenCode `1.17.10` plugin and the sanitized
evidence behind
[`interactive-opencode.md`](../../../docs/product/internal-mode/interactive-opencode.md).

The proof ran on `<executor-host>` in an **agent-launched OpenCode TUI with
default settings**. The TUI ran `deepseek/deepseek-flash` (shown as DeepSeek
V4.1 Flash), with no `--port`, no server password, and no bypass flags. A human
did not start the session. Khala hosted no agent process: the plugin ran inside
the TUI's own worker.

## Reproduce

1. Run `npm ci --ignore-scripts` in `probe/workspace/.opencode/` to install the
   pinned proof dependencies.
2. Point `KHALA_PROOF_DIR` at a private scratch directory outside the
   repository, then run `probe/drive.sh init`.
3. Run `probe/drive.sh launch` to start the TUI with OpenCode `1.17.10` on
   `PATH`. Add `--session <id>` to relaunch the same session.
4. Bind the session: have the agent call `khala_read` once.
5. For each trial:
   1. set the mode with `drive.sh q mode <mode>[:once|sticky[:tail-message|append-user]]`;
   2. type the prompt with `drive.sh type prompts/<file>`;
   3. enqueue the fixture with `drive.sh enq <fixture>`, while the long tool is
      running or while the session is idle, depending on the trial.
6. Compare the event order with `evidence/mode-events.jsonl`. A successful call
   or a stored prompt is not a pass: the required nonce must reach `khala_send`
   in the same TUI session.
7. Run `node probe/session-safety.mjs`. It exercises the fixture's
   wrong-session, draft-preservation, multi-batch, and failed-submit guards.

The proof plugin is not product code. It uses a file-backed channel fixture to
model bounded batches, single-use tokens, logged resets, and next-call
acknowledgement. It never captures assistant output as channel output.

## Evidence index

- [`inventory.md`](inventory.md): binaries, hashes, target selection, and CLI
  surfaces.
- [`source-notes.md`](source-notes.md): exact-version native-surface inventory.
- [`evidence/results.md`](evidence/results.md): launch record, per-trial
  timestamp tables, and interpretation.
- [`evidence/mode-events.jsonl`](evidence/mode-events.jsonl): raw plugin, queue,
  and driver events. Every plugin line carries `sessionID`, `launchID`, and
  `opencodeVersion`.
- [`evidence/session-transcript.jsonl`](evidence/session-transcript.jsonl): the
  stored session transcript (`opencode export`), reduced to one line per part.
- [`evidence/server-auth.md`](evidence/server-auth.md): authenticated-server
  checks and the embedded-TUI blocker for external companions.
- [`evidence/session-safety.md`](evidence/session-safety.md): deterministic
  two-session and failed-submit guard evidence.
- [`evidence/sanitization.md`](evidence/sanitization.md): retained-data and
  cleanup policy.
