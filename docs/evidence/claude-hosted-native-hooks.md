# Hosted Claude native Steer and Sync probe

## Result

Claude Code `2.1.286` accepts model-visible `PostToolUse` additional context and a
model-visible `Stop` block reason. This proves the two *hook boundaries* exist
in a disposable model process. It does **not** prove hosted proof-key Steer or
Sync. Both remain typed `unsupported` for this exact version; other versions
remain `unknown` in `hostedClaudeNativeModeEvidence`.

The hosted manual MCP route previously had no authenticated path from its held
connector binding and generation to the plugin's separate hook command. The
new Claude-only bridge opens a user-private Unix socket in the live MCP
process after it resolves the held binding. The hook presents the per-process
secret from a same-user descriptor. The MCP process checks the current
effective mode and binding before selecting the inbox batch. It retains a
one-use receipt scoped to the exact session, binding, generation, ordered
release IDs and `PostToolUse` or `Stop` boundary. The model receives the opaque
receipt in hook context and must later call `khala_hook_receipt`; that call
rechecks current authority and commits the durable inbox ACK before returning
the correlated receipt. A wrong nonce, pause, revocation, generation change or
MCP restart fails closed. The local Claude session ID is still a caller-supplied
label. [Claude Code exposes that ID to Bash subprocesses](https://code.claude.com/docs/en/env-vars),
while its [published hook input](https://code.claude.com/docs/en/hooks) has no
signed invocation field. A same-user subprocess
can read the descriptor and imitate a hook request. Thus the bridge stops a
remote room peer from manufacturing binding/generation/release receipt fields
or guessing an unseen one-use nonce, but does not prove provider-origin hook
invocation against a compromised local model tool. Stronger provenance needs a
trusted Claude-side hook channel or a separately isolated hook process with a
credential unavailable to Bash tools; neither is in the installed command-hook
contract.

The bridge has passed exact-session component tests, including a real local
MCP process, actual hook socket round trip for both Steer and Sync, ordered
fixture releases, a later tool call and durable ACK. **No owner-selected live release has yet shown the
receipt in a disposable saved Claude model session.** #701 must therefore
keep hosted Steer and Sync typed unsupported; the code is not evidence for an
effective mode. Neither hook installation, version string, ciphertext
transport nor peer text can fill the remaining live-proof gap.

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

The next gate is a real owner-selected release and model-visible, correlated
receipt in a disposable saved session for each mode. It must show the model
calling `khala_hook_receipt` after the hook context, the exact binding and
generation in that result, and the durable ACK for the ordered release IDs.
#701 remains the single writer of shared hosted composition and must only
advertise support for the exact route and version after that proof. #49's
all-three-mode acceptance remains blocked for hosted Claude meanwhile.
