# Hosted Claude native Steer and Sync probe

## Result

Claude Code `2.1.286` accepts model-visible `PostToolUse` additional context and a
model-visible `Stop` block reason. This proves the two *hook boundaries* exist
in a disposable model process. It does **not** prove hosted proof-key Steer or
Sync. Both remain typed `unsupported` for this exact version; other versions
remain `unknown` in `hostedClaudeNativeModeEvidence`.

The hosted manual MCP route has no authenticated path from its held connector
binding and generation to the plugin's separate hook command. The plugin's
`sessionGranted` check recognizes only an internal-launch grant under the
internal runtime directory. The hosted MCP process owns its own proof-key
connector; its `khala_read` and `khala_status` tools do not issue a hook
challenge, return a model-visible delivery receipt, or attest that the next
call followed a particular native hook. Its local Claude session ID is a
caller-supplied label, not proof of provider session identity. Neither a hook
installation, a version string, ciphertext transport, nor a peer's text can
fill this gap.

## Disposable native observations

The installed binary reported `2.1.286`. A private temporary settings file
registered command hooks for `PostToolUse` and `Stop`; the hooks emitted fixed,
non-channel markers. In a disposable model call that used Bash, the final model
response contained both the tool-boundary context marker and the Stop reason
marker. A separate saved-session probe created one private session in a
writable temporary Claude config directory, then resumed the same ID. The
initial and resumed model responses contained the Stop marker. The model did
not call a tool in those saved-session turns, despite tool-requesting prompts,
so that probe does not establish saved-session `PostToolUse` delivery. Session
IDs, credentials, raw transcript and private markers are not retained here.
No production channel release or send was made.

## Acceptance probe and next route

`packages/harnesses/src/claude/hosted-native.test.ts` contains an
expected-failing acceptance assertion: both hosted modes require a non-null
authenticated native receipt and `proven` support. It currently fails by
design, while the fail-closed assertions pass. Run it with:

```sh
pnpm exec vitest run packages/harnesses/src/claude/hosted-native.test.ts
```

The smallest route is a hook-to-hosted-MCP bridge with a private per-launch
credential and a server-issued, one-use challenge scoped to the exact session,
binding, generation, release and hook boundary. The hosted connector must
validate that challenge against its current held binding before consuming a
batch, then correlate a later agent-origin call and durable acknowledgement to
that delivered batch. Revocation, generation change, pause and restart must
invalidate stale challenges. This needs a real owner-selected release and
model-visible, correlated receipt in a disposable saved session before either
mode may become effective. #701 remains the single writer of shared hosted
composition and may consume the typed negative evidence now; #49's all-three
mode acceptance remains blocked for hosted Claude.
