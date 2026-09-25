# MCP piggyback format proof

This isolated fixture proves the proposed shared tokenized MCP batch format with
`codex-cli 0.154.0`. It has no product-package imports and changes no capability
record. The MCP server returns primary tool content first, followed by a clearly
delimited untrusted channel-data batch containing an opaque token and exact
canonical release JSON.

The retained proof covers eight FIFO releases, channel and author provenance,
escaped and multibyte bodies, a complete serialized JSON-RPC response of exactly
128 KiB, and one whole maximum-size release whose envelope exceeds that soft
limit. In every case Codex makes a later Khala call carrying only the exact
`ackBatchToken`; the verifier rejects any transmitted or reported release-ID
state, so the successful workflow requires no receiver-side duplicate filter.

## Validate retained evidence

From the repository root, using Node 22.23.2 or 24.18.0:

```sh
node --test experiments/internal-mode/mcp-piggyback/test/*.test.mjs
node experiments/internal-mode/mcp-piggyback/verify.mjs \
  experiments/internal-mode/mcp-piggyback/evidence/live-run.json
```

## Repeat the live proof

The runner creates a private directory under `$TMPDIR`, copies only the current
Codex authentication file into it, and deletes the directory after all three
cases. It uses normal trust settings and `--approve-for-me`; it never uses a
dangerous approval, sandbox, hook-trust, or permissions bypass.

```sh
node experiments/internal-mode/mcp-piggyback/run-live.mjs
```

The exact underlying command shape, version, session IDs, model observations,
tool arguments, complete-response byte counts, and negative claims are retained
in `evidence/live-run.json`. The process is accurately described as
agent-launched, not user-started.

## Scope

This proves only that the pinned host can consume the shared response format and
return its opaque acknowledgement token without a release-ID filter. It does
not prove the product inbox implementation, durable restart behavior, idle wake,
`sync`, `steer`, arbitrary-tool injection, or capability advertising.
