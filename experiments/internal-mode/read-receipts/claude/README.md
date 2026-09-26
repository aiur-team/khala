# Claude read-receipt evidence

Proof for `claude-read-receipts` (`docs/product/internal-mode/read-receipts.md`): in an
ordinary user-started interactive Claude CLI, the plugin's hooks deliver the shared batch,
the token stays inside the local Khala server, and the agent's **next** authenticated Khala
call returns it. Only then may `interactiveClaudeCapabilities` report the route `tested`,
and only for the exact version/route pair in `evidence.json` `provenPairs` (mirrored in
`CLAUDE_INTERACTIVE_PROVEN`).

**Status: unproven.** Two Executor live runs on 2026-09-26 used Claude Code 2.1.283.

- The first run failed because the server composed the Claude session route as unproven. Every hook
  pull and `khala_read` was refused before any batch or token existed.
- The second run is recorded in `evidence.json`. It used origin/main `ce39721`, after #418 and #425.
  Delivery, framing, idle and busy behaviour, reconnect and Stop all behaved as specified. The agent's
  next Khala call moved the inbox cursor. However, the owner's receipts never held an
  `agent_acknowledged` fact, because the internal Claude read port records no acknowledgement. Wrong
  token and wrong generation could not be reached live.

Until then every inspected version stays `experimental`. It delivers with `batch_token_next_call` so
that a live run can exercise it, and it is labelled experimental rather than proven (decisions 34
and 37).

```sh
node --test experiments/internal-mode/read-receipts/claude/scan.test.mjs
node experiments/internal-mode/read-receipts/claude/scan.mjs <run-dir> <canary>...
```

Offline conformance lives in `packages/agent-cli/src/composition/claude-read-receipts.test.ts`
and `packages/harnesses/src/claude/interactive.test.ts`.

## Live run (ordinary CLI, normal trust settings)

Use a disposable channel, the user's own `claude` started in a TTY, the installed plugin, and
no restricted profile. Record, per scenario, only a non-secret label and a redacted
presence/equality result: batch delivered, untrusted-content framing present, idle and busy
delivery, no later call (neutral), missing-token conformance failure, duplicate token, wrong
binding/generation/token, reconnect. Never retain token bytes, digests, or message content.
Run `scan.mjs` over the run directory with the run's canaries before committing, then add the
pair to `provenPairs` and `CLAUDE_INTERACTIVE_PROVEN` together.
