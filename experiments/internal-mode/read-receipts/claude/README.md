# Claude read-receipt evidence

Proof for `claude-read-receipts` (`docs/product/internal-mode/read-receipts.md`): in an
ordinary normal-trust interactive Claude CLI, the plugin's hooks deliver the shared batch,
the token stays inside the local Khala server, and the agent's **next** authenticated Khala
call returns it. Only then may `interactiveClaudeCapabilities` report the route `tested`,
and only for the exact version/route pair in `evidence.json` `provenPairs` (mirrored in
`CLAUDE_INTERACTIVE_PROVEN`).

**Status: proven for receipts on the exact Claude Code 2.1.283 interactive-hooks route.** Three Executor live runs on 2026-09-26 used that version. The latest run and its follow-up diagnostics are documented in [live-run-2026-09-26.md](live-run-2026-09-26.md). Decision 43 permits an Executor-launched TUI under normal trust; the person-started fixture of #236 remains separate. The later, separately retained [installed native mode proof](../../listening-modes/claude/README.md) covers `steer`, `sync`, and `async` on that exact version and route.

- The first run failed because the server composed the Claude session route as unproven. Every hook
  pull and `khala_read` was refused before any batch or token existed.
- The second run was previously recorded in `evidence.json`. It used origin/main `ce39721`, after #418 and #425.
  Delivery, framing, idle and busy behaviour, reconnect and Stop all behaved as specified. The agent's
  next Khala call moved the inbox cursor. However, the owner's receipts never held an
  `agent_acknowledged` fact, because the internal Claude read port records no acknowledgement. Wrong
  token and wrong generation could not be reached live.
- The third run used merged receipt build `d389c79` and a native TUI under normal trust. Native next-call acknowledgements were recorded, including after reconnect and owner Stop/rejoin. A fresh disposable continuation showed omitted-token refusal and exact-token duplicate idempotency against a native pending batch, with the native call in between recording one event-linked receipt. Wrong-input and duplicate probes used the local HTTP boundary; they are not claimed as native malformed plugin calls.

Other inspected versions stay `experimental` and use the owner's explicit experimental-route grant (decisions 34 and 37). This receipt result alone did not promote any mode or idle wake; the separate native mode proof gates the exact version's mode claims.

```sh
node --test experiments/internal-mode/read-receipts/claude/scan.test.mjs
node experiments/internal-mode/read-receipts/claude/scan.mjs <run-dir> <canary>...
```

Offline conformance lives in `packages/agent-cli/src/composition/claude-read-receipts.test.ts`
and `packages/harnesses/src/claude/interactive.test.ts`.

## Live run (ordinary CLI, normal trust settings)

Use a disposable channel, a normal-trust `claude` started in a TTY under decision 43, the installed plugin, and
no restricted profile. Record, per scenario, only a non-secret label and a redacted
presence/equality result: batch delivered, untrusted-content framing present, idle and busy
delivery, no later call (neutral), missing-token conformance failure, duplicate token, wrong
binding/generation/token, reconnect. Never retain token bytes, digests, or message content.
Run `scan.mjs` over the run directory with the run's canaries before committing, then add the
pair to `provenPairs` and `CLAUDE_INTERACTIVE_PROVEN` together.
