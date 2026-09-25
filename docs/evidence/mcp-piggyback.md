# MCP piggyback end-to-end evidence

Contract: [`mcp-piggyback-evidence`](../product/internal-mode/mcp-piggyback.md#contract-4--pinned-end-to-end-mcp-delivery-evidence).
Fixture, verifier, and retained data are in
[`experiments/internal-mode/mcp-piggyback/e2e/`](../../experiments/internal-mode/mcp-piggyback/e2e/).

> **Status: live runs pending.** The three interactive Codex runs have not
> completed yet: the host's Codex account reached its usage limit before the
> first model turn. Until the live section below is filled and
> `verify.mjs` passes on retained evidence, nothing here supports advertising
> MCP-only `async` or `acknowledgement: batch_token_next_call`.

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

Each guarded line below was reverted in place, its focused test was run and
failed (`pass 0, fail 1`), and the file was restored:

| Reverted guard | Focused test that failed |
|---|---|
| `verify.mjs`: a call needs a matching rollout entry | `wrong implementation: fixture invokes khala_read while the agent never selects it` |
| `verify.mjs`: no release-ID state in call arguments | `wrong implementation: no Khala next-call acknowledgement plus a Codex-side seen-ID set` |
| `verify.mjs`: no replay after the exact token echo | same |
| `verify.mjs`: durable cursor advances exactly once | same |
| `verify.mjs`: a later call must echo the exact token | `missing exact next-call acknowledgement fails` |
| `verify.mjs`: restart replays identical token and bytes | `restart must replay the identical outstanding batch` |
| `verify.mjs`: async token echoed on a deliberate `khala_send` | `the async token must be echoed on a deliberate khala_send` |
| `verify.mjs`: at most one batch per result | `a non-read result with the batch appended twice fails` |
| `server.ts`: strip object `_meta` | `accepts the reserved object _meta that Codex sends on every request method` |
| `result-postprocessor.ts`: report suppression | `fails open on status, storage, and invalid UTF-8 without partial content`; `app.test.ts` drift cases |

## Live runs

Pending (see status above).

## Negative claims

- The Codex TUIs are agent-launched with default settings, not user-started.
- No hosted agent, app-server, `codex exec`, transcript capture, or assistant
  output capture is part of the proof.
- Idle wake, `sync`, `steer`, and delivery at non-Khala tool boundaries remain
  unproven.
- This evidence changes no capability record; `listening-mode-contract` owns
  that.
