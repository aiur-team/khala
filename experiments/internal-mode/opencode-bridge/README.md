# OpenCode bridge proof

This throwaway experiment proves that a local OpenCode plugin can append a
Khala-shaped user message after `session.idle`, submit it, and have the
configured DeepSeek provider consume it.

Tested on 2026-09-24 with OpenCode, `@opencode-ai/plugin`, and
`@opencode-ai/sdk` `1.17.10`. The plugin emitted a fixed release marker and
DeepSeek replied exactly `PLUGIN-PUSH-DEEPSEEK-OK` in the same session.

Run OpenCode with this directory as the project root so it discovers
`.opencode/plugins/khala-proof.js`. Send an initial prompt and wait for the
session to become idle. The plugin injects once. It is deliberately not product
code: it has no binding, durable cursor, dedupe, pause/stop, or capability gate.

The proof uses the global TUI append/submit API. The proposed product design in
`docs/product/internal-mode/opencode-bridge.md` instead uses the
session-addressed API so it cannot submit a different session's draft.
