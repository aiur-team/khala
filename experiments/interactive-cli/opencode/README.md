# OpenCode interactive-CLI proof

This directory retains the throwaway OpenCode `1.17.10` plugin and the
sanitized evidence used by
[`interactive-opencode.md`](../../../docs/product/internal-mode/interactive-opencode.md).
The proof ran on `<executor-host>` in a person-started OpenCode TUI with
`deepseek/deepseek-flash` (displayed as DeepSeek V4.1 Flash). Khala did not
launch or host an agent process.

## Reproduce

1. Install the pinned proof workspace dependencies with `npm ci --ignore-scripts`
   in `probe/workspace/.opencode/`.
2. Create private state and log files outside the repository, both mode `0600`,
   and point `KHALA_PROOF_STATE` and `KHALA_PROOF_LOG` at them.
3. Start the interactive TUI yourself from `probe/workspace/` with OpenCode
   `1.17.10`, `--hostname 127.0.0.1`, an explicit port, and
   `--model deepseek/deepseek-flash`. Do not use `--prompt`; type the prompts
   into the TUI.
4. Use `probe/queue.mjs` to initialize and enqueue the fixture for the mode under
   test while `proof_gate` stage 1 is running.
5. Compare the event order with `evidence/mode-events.jsonl`. A successful HTTP
   call or stored prompt is not a pass: the required nonce must reach
   `khala_send` in the same visible TUI session.
6. Run `node probe/session-safety.mjs` to exercise the committed fixture's
   wrong-session, draft-preservation, multi-batch, and failed-submit guards.

The proof plugin is intentionally not product code. It uses a file-backed
channel fixture to model bounded batches, stable tokens, and next-call
acknowledgement. It never captures assistant output as channel output.

## Evidence index

- [`inventory.md`](inventory.md): binaries, hashes, target selection, and CLI
  surfaces.
- [`source-notes.md`](source-notes.md): exact-version native-surface inventory.
- [`evidence/results.md`](evidence/results.md): commands, observations, and
  timing interpretation.
- [`evidence/mode-events.jsonl`](evidence/mode-events.jsonl): sanitized raw
  event subset for the three modes and restart trial.
- [`evidence/server-auth.md`](evidence/server-auth.md): authenticated server
  positive/negative checks and the embedded-TUI blocker.
- [`evidence/session-safety.md`](evidence/session-safety.md): deterministic
  two-session and failed-submit guard evidence for the hardened fixture.
- [`evidence/sanitization.md`](evidence/sanitization.md): retained-data and
  cleanup policy.
