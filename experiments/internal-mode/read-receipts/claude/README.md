# Claude read-receipt evidence

Proof for `claude-read-receipts` (`docs/product/internal-mode/read-receipts.md`): in an
ordinary user-started interactive Claude CLI, the plugin's hooks deliver the shared batch,
the token stays inside the local Khala server, and the agent's **next** authenticated Khala
call returns it. Only then may `interactiveClaudeCapabilities` advertise
`batch_token_next_call`, and only for the exact version/route pair in `evidence.json`
`provenPairs` (mirrored in `CLAUDE_INTERACTIVE_PROVEN`).

**Status: unproven.** No authorized disposable live run is retained, so nothing is advertised.

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
