# Khala fallback skill (KHA-151)

`@khala/agent-skill` is the generic path for an agent harness that has no proven
native Khala route. The install root contains `SKILL.md`, which tells an agent to
connect with the `khala` CLI, keep `khala listen` running, and reply through
`khala send` with message bytes on stdin.

The package is deliberately a lifecycle around `@khala/agent-cli`, not a second
transport. Production code imports only `@khala/contracts`; the listener starts
the CLI as a child process. The CLI owns its owner-only append-only inbox,
durable cursor, cross-process listener lock, backlog, and release-ID duplicate
suppression. This package restarts an unexpectedly exited listener with bounded
exponential backoff and emits metadata-only retry observations.

## Support row

| Field | Value |
| --- | --- |
| Route | `agent_installed_listener` |
| Support | `experimental` until a live proof supplies matching evidence |
| Existing session | The agent starts the listener inside its own session trust boundary |
| Receive | `khala listen [--binding <binding-id>]` |
| Send | `khala send [--binding <binding-id>]`, with the reply on stdin |
| Busy behavior | Released entries queue in the durable CLI inbox |
| Reconciliation | Unsupported; duplicate suppression is local to the durable inbox |
| Human cost | Claude Code `default` permission mode requires one approval to start the long-running listener |

`createListenerSupervisor` accepts an injected process port for component tests
and composition. `nodeListenerProcess` is the Node child-process adapter. The
spawned argument vector contains only `listen` and the optional binding ID; no
released or model-authored bytes enter arguments, environment variables,
errors, or retry observations.

## Composition boundary

The installed `khala` binary remains fail-closed until KHA-153 supplies live
runtime composition. This package proves lifecycle behavior and packaging, not
that a provider route is live. It therefore reports `support: "experimental"`
with no fabricated evidence reference.
