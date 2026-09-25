# MCP piggyback end-to-end evidence

Contract: [`mcp-piggyback-evidence`](../product/internal-mode/mcp-piggyback.md#contract-4--pinned-end-to-end-mcp-delivery-evidence).
Fixture, verifier, and retained data are in
[`experiments/internal-mode/mcp-piggyback/e2e/`](../../experiments/internal-mode/mcp-piggyback/e2e/).

> **Status: proved on Codex 0.154.0** (2026-09-25). Three interactive runs pass
> `verify.mjs` on the retained
> [`live-run.json`](../../experiments/internal-mode/mcp-piggyback/e2e/evidence/live-run.json):
> the async run, the non-read run, and the forced restart. This is evidence for
> MCP-only `async` and `acknowledgement: batch_token_next_call` on
> `codex-cli 0.154.0` only. `listening-mode-contract` owns the capability
> change.

## Fixture

The MCP server Codex launches is the product `khala mcp-serve` command
(`runCli(['mcp-serve'])`), with the real durable inbox, the product result
postprocessor, and the product `khala_read`. Only two pieces are fixture code:

- a held binding read from the fixture directory, standing in for the connector
  that is not live yet;
- a send port that records the deliberate outbound `khala_send` body instead of
  publishing it.

Khala-side messages are encoded with the policy package's canonical release
encoder (`encodeReleasePayload`) and enqueued with `openInbox().enqueue`, from
stdin, never argv. Every JSON-RPC line in both directions is tapped into the
fixture's `events.jsonl`. The verifier treats a call as **agent-issued** only
when Codex's own session rollout records the model choosing that tool with the
same arguments; a call the fixture injected has no rollout entry and fails.

Codex runs as the interactive TUI in a private tmux server, with the host's
real `~/.codex`, a project-scoped MCP entry, and no trust-bypass flag. It is
**agent-launched with default settings**, not user-started (decisions 33 and
43).

## Finding: `mcp-serve` did not start under Codex 0.154.0

The first real launch failed with `MCP startup failed: Mcp error: -32602:
Invalid params`. The tap log showed why:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"progressToken":0}}}
{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Invalid params"}}
```

MCP reserves `_meta` on every request's params, and Codex sends it on
`tools/list`. `mcp-serve` required empty params, so Codex never saw the Khala
tools. This PR accepts and ignores an object `_meta` on every method
(`packages/agent-cli/src/mcp/server.ts`). After the fix the same TUI listed
`khala_send` and `khala_read` without error.

## Finding: batch byte-budget headroom

`mcpPayloadBudget` divides the space left under the 128 KiB soft limit by a
worst-case 6x JSON escape expansion. Measured with
`tsx experiments/internal-mode/mcp-piggyback/e2e/headroom.ts` (retained as
[`headroom.json`](../../experiments/internal-mode/mcp-piggyback/e2e/evidence/headroom.json)),
a `khala_send` result admits **19,962 payload bytes**:

| Body | Releases | Response bytes | Share of 128 KiB | Expansion |
|---|---:|---:|---:|---:|
| plain ASCII | 1 / 8 | 20,739 / 22,493 | 16% / 17% | 1.04x / 1.13x |
| typical chat | 1 / 8 | 22,895 / 24,277 | 17% / 19% | 1.15x / 1.23x |
| escaped control characters | 1 / 8 | 24,019 / 25,453 | 18% / 19% | 1.20x / 1.28x |
| quote-heavy | 1 / 8 | 40,433 / 40,293 | 31% | 2.03x / 2.02x |
| raw control bytes (non-canonical) | 1 | 120,531 | 92% | 6.04x |

Canonical release JSON already escapes control characters, so re-embedding it
in the JSON-RPC line can at most double a byte (`"` and `\`). Only a payload
with raw control bytes reaches 6x, and the inbox does not currently reject one.
Normal batches therefore use under a fifth of the soft limit.

**Recommendation:** budget from the exact serialized size. JSON string escaping
is per code point, so each release's contribution to the final line is exact and
additive and can be computed before staging. That lets ordinary chat use most of
the 128 KiB limit, and it stays exact for the pathological case. A cheaper
alternative is to reject non-canonical payloads at enqueue and use a 2x divisor.
Both change the inbox selection API, so they are left to a follow-up ticket.

## Finding: suppressed batches were silent

When a binding check, inbox selection, or rendering step suppressed a batch,
the postprocessor returned the plain tool result and logged nothing. It now
reports a content-free `{stage, code}` and `mcp-serve` writes one stderr line,
for example
`{"ok":false,"warning":"batch_suppressed","stage":"read","code":"storage_failed"}`.
The tool result is unchanged.

## Tests and guarded lines

```sh
node --test experiments/internal-mode/mcp-piggyback/e2e/test/verify.test.mjs
pnpm --filter @khala/agent-cli exec vitest run --config ../../vitest.config.ts
```

`retained live evidence passes` runs the verifier on the real data, and
`retained live evidence fails both wrong implementations` applies the contract's
two wrong-implementation mutations to it.

Each guarded line below was reverted in place, its focused test was run and
failed (`pass 0, fail 1`), and the file was restored:

| Reverted guard | Focused test that failed |
|---|---|
| `verify.mjs`: a call needs a matching rollout entry | `wrong implementation: fixture invokes khala_read while the agent never selects it` |
| `verify.mjs`: the rollout entry carries the model's own tool code | `a rollout call without the model-written tool code is not agent-issued` |
| `verify.mjs`: no queued marker in any model-input message | `queued message content anywhere in the model input fails` |
| `verify.mjs`: no release-ID state in call arguments | `wrong implementation: no Khala next-call acknowledgement plus a Codex-side seen-ID set` |
| `verify.mjs`: no replay after the exact token echo | same |
| `verify.mjs`: durable cursor rests on the last queued release | same |
| `verify.mjs`: a later call must echo the exact token | `missing exact next-call acknowledgement fails` |
| `verify.mjs`: restart replays identical token and bytes | `restart must replay the identical outstanding batch` |
| `verify.mjs`: async token echoed on a deliberate `khala_send` | `the async token must be echoed on a deliberate khala_send` |
| `verify.mjs`: at most one batch per result | `a non-read result with the batch appended twice fails` |
| `server.ts`: strip object `_meta` | `accepts the reserved object _meta that Codex sends on every request method` |
| `result-postprocessor.ts`: report suppression | `fails open on status, storage, and invalid UTF-8 without partial content`; `app.test.ts` drift cases |

## Live runs

Recorded 2026-09-25 with `codex-cli 0.154.0` (`gpt-6-astra`, medium, the host
default). Each TUI ran in the private tmux server `kh201` with its own project
and fixture directory:

```sh
tsx experiments/internal-mode/mcp-piggyback/e2e/khala.ts setup <fixture> <run>
node experiments/internal-mode/mcp-piggyback/e2e/setup-project.mjs <project> <fixture>
tsx experiments/internal-mode/mcp-piggyback/e2e/khala.ts enqueue <fixture> < messages.json
tmux -L kh201 new-session -d -s <run> -x 220 -y 55 -c <project> codex
# restart run only, before the first prompt:
node experiments/internal-mode/mcp-piggyback/e2e/kill-after-delivery.mjs <fixture> 300
tsx experiments/internal-mode/mcp-piggyback/e2e/khala.ts status <fixture>
node experiments/internal-mode/mcp-piggyback/e2e/collect.mjs manifest.json \
  experiments/internal-mode/mcp-piggyback/e2e/evidence/live-run.json
node experiments/internal-mode/mcp-piggyback/e2e/verify.mjs \
  experiments/internal-mode/mcp-piggyback/e2e/evidence/live-run.json   # {"proved": true, "failures": []}
```

Each launch answered Codex's update prompt with **Skip** (staying on 0.154.0)
and its folder-trust prompt with **Yes**. Every Khala call was allowed at
Codex's default MCP approval prompt with **Allow** (this call only). No
session-wide approval or bypass flag was used. The three scratch trust entries
were removed from `~/.codex/config.toml` afterwards.

Two unique messages were queued before each launch. The typed prompts never
mention them, and a scan of every model-input message (instructions,
environment context, prompts) found 0 marker hits in each run.

| Run | Typed prompts | Khala calls (the model's own code, from the rollout) | Result |
|---|---|---|---|
| async | "Check my Khala channel for anything new…"; "Please reply on the channel: Thanks both…"; "Check the Khala channel again…" | `khala_read({})` → batch `031b67f3…` (2 releases, 1,539 B); `khala_send({ackBatchToken: "031b67f3…", message})` → `accepted`; `khala_read({ackBatchToken: "031b67f3…"})` → `empty` | Relayed both bodies with channel and author. The token was echoed on a deliberate send. The cursor rests on the last release. |
| nonRead | "Post this to my Khala channel: Starting the release checklist now."; "Post to the channel: Checklist step one is done." | `khala_send({message})` → `accepted` + one appended batch `4f7a64f5…` (1,710 B); `khala_send({message, ackBatchToken: "4f7a64f5…"})` → `accepted` | The postprocessor appended the batch exactly once, after the primary result. The next call acknowledged it. |
| restart | session 1: "Check my Khala channel…"; session 2: the same, then "Reply on the channel…", then "Check the Khala channel again…" | session 1: `khala_read({})` → batch `81c19250…`, then SIGKILL of Codex and the server at 22:05:07.373Z; session 2: `khala_read({})` → the same token and batch bytes (sha256 `6005e745…`), `khala_send({ackBatchToken})` → `accepted`, `khala_read({ackBatchToken})` → `empty` | Khala replayed the identical outstanding batch in a new Codex session. It advanced exactly once after the echo. |

Observations:

- **Codex 0.154.0 calls MCP tools from model-written code.** The rollout
  records a `custom_tool_call` named `exec` with input such as
  `text(await tools.mcp__khala__khala_read({}));`, then an `item_completed`
  `McpToolCall` item with the server, tool, and arguments. The verifier treats a
  call as agent-issued only when both are present and match the server's tap
  log.
- **A repeated echo is harmless.** In the async and restart runs the model
  echoed an already-acknowledged token on its next read. Khala returned `empty`
  and did not move the cursor, which is the boundary behaviour the contract
  needs.
- **The receiver kept no deduplication state.** No call argument carried a
  release ID. The only acknowledgement was the exact token.
- Every MCP server's parent was the Codex binary on an interactive `/dev/pts`
  terminal (recorded per serve process in the evidence).

## Negative claims

- The Codex TUIs are agent-launched with default settings, not user-started.
- No hosted agent, app-server, `codex exec`, transcript capture, or assistant
  output capture is part of the proof. Replies were read afterwards from
  Codex's own local rollout. The driving agent read the tmux screen only to
  answer Codex's prompts, and fed nothing from it back into Codex.
- Idle wake, `sync`, `steer`, and delivery at non-Khala tool boundaries remain
  unproven.
- This evidence changes no capability record; `listening-mode-contract` owns
  that.
