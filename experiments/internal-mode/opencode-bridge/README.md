# OpenCode bridge proof

This throwaway experiment proves that a local OpenCode plugin can append a
Khala-shaped user message after `session.idle`, submit it, and have the
configured DeepSeek provider consume it.

Tested on 2026-09-24 with OpenCode, `@opencode-ai/plugin`, and
`@opencode-ai/sdk` `1.17.10`. The proof source has no package imports, so a
separate npm install is not required; OpenCode supplies the plugin client at
runtime. Sanitized raw output and the versioned host path are retained in
[`evidence.md`](evidence.md).

From a clean checkout with DeepSeek credentials already configured, run these
preflights from the repository root:

```sh
test "$(opencode --version)" = "1.17.10"
opencode models deepseek
opencode models deepseek | rg -x 'deepseek/deepseek-flash'
```

The model assertion passed for the recorded proof. During final review, a fresh
OpenCode data directory instead listed `deepseek/deepseek-v4-flash`,
`deepseek/deepseek-v4-flash-vision-exp`, and `deepseek/deepseek-v4-pro`; the
recorded model was absent. An exact replay therefore currently stops at this
preflight. Do not substitute another model and call it the same proof.

Then start the pinned model with the experiment directory as the project root:

```sh
opencode experiments/internal-mode/opencode-bridge \
  --model deepseek/deepseek-flash
```

Send `Reply with exactly SEED-DEEPSEEK-OK.` and wait for the session to become
idle. OpenCode discovers `.opencode/plugins/khala-proof.js`; the plugin injects
once. The proof passes only if the next assistant message is exactly
`PLUGIN-PUSH-DEEPSEEK-OK`. A missing model, version mismatch, plugin load
failure, wrong session, or provider drift therefore fails with a visible
preflight or marker mismatch.

The plugin is deliberately not product code: it has no binding, durable cursor,
dedupe, pause/stop, or capability gate.

The proof uses the global TUI append/submit API. The proposed product design in
`docs/product/internal-mode/opencode-bridge.md` instead uses the
session-addressed API so it cannot submit a different session's draft.
