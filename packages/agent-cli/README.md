# Khala agent CLI (KHA-148)

`@khala/agent-cli` owns the `khala` binary an agent uses to connect to a room,
consume released messages, send replies, inspect status, and expose the same send
operation as an MCP tool.

```text
khala connect <https-room-link>
khala listen [--binding <binding-id>]
printf '%s' '<message>' | khala send [--binding <binding-id>]
khala status
khala mcp-serve
```

Released or model-authored bytes are accepted only through stdin, MCP stdio, or
an injected request body. They never enter process arguments, environment
variables, status, errors, or logs. `listen` is the only command that writes
released bytes to stdout; `mcp-serve` reserves stdout for JSON-RPC.

## Support row

| Field | Value |
| --- | --- |
| Package | `@khala/agent-cli`, binary `khala` |
| Connect | KHA-114 bootstrap through an injected composition port; retries reuse one deterministic operation ID. |
| Receive | A released-delivery port appends exact payload bytes to the per-binding inbox; KHA-116's pending-review subscription is deliberately not used as a model feed. |
| Send | One injected capability-backed send port shared by `khala send` and the `khala_send` MCP tool. |
| Required human setup | None in the CLI. Provider route installation and capability selection belong to KHA-149, KHA-150, and KHA-153. |
| Reconciliation | Enqueue deduplicates immutable release IDs. Consumer acknowledgement advances only after output succeeds; a crash before acknowledgement may redeliver. |

## Durable inbox

Each binding generation has an owner-only directory containing an append-only,
versioned JSONL inbox and an independently persisted consumer cursor. Enqueue
validates the binding generation, event references, payload bound, and SHA-256
digest before appending and syncing. Cursor replacement is atomic. An incomplete
final frame is ignored until replay completes it; a corrupt complete frame is
refused. A Unix-domain listener lock permits only one consumer.

The encrypted-source cursor owned by KHA-116, this released-inbox position, and
the agent-consumer acknowledgement are separate facts. Status never exposes
payloads or capabilities.

## MCP mode

`khala mcp-serve` speaks newline-delimited JSON-RPC on stdin/stdout and exposes
exactly one tool, `khala_send`, with `{ message, bindingId? }`. Unknown tools,
unknown arguments, and unheld bindings are refused. Results contain only the
stable client transaction ID and outcome, never the submitted message.

## Composition boundary

Only `src/composition/` imports sibling implementation packages. The CLI, inbox,
and MCP modules depend on package-owned ports and shared contract types.
`createConnectorBootstrapClient` adapts KHA-114; KHA-153 supplies the live agent
capability routes and runtime state.

## Not proven here

Component tests use injected ports. They prove parsing, durability, process
isolation, MCP framing, and packaging—not that a provider route is live. The
installed binary connects only after KHA-153 supplies live composition; its
default transport fails closed. Native routes remain owned by KHA-149, KHA-150,
and KHA-151 and may claim support only from their exact evidence.
