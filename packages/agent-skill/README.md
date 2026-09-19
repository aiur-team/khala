# Khala fallback skill (KHA-151)

`@khala/agent-skill` is the generic path for an agent harness that has no proven
native Khala route. The install root contains `SKILL.md`, which tells an agent to
connect with the `khala` CLI, keep the supervised listener running, and reply
through `khala send` with message bytes on stdin.

Install this directory at `$CODEX_HOME/skills/khala/` (by default
`~/.codex/skills/khala/`) for Codex, or `~/.claude/skills/khala/` for Claude
Code. Both the package-provided `khala-fallback` executable and the underlying
`khala` executable must be available on `PATH`.

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
| Receive | `khala-fallback listen --binding <binding.bindingId>`, which supervises `khala listen --binding <binding.bindingId>` |
| Send | `khala send --binding <binding.bindingId>`, with the reply on stdin |
| Busy behavior | `unknown`; the durable inbox retains released entries, but the fallback does not claim harness busy-state semantics |
| Reconciliation | Unsupported; duplicate suppression is local to the durable inbox |
| Human cost | Claude Code `default` permission mode requires one approval to start the long-running listener |

The `khala-fallback` binary accepts only `listen --binding <binding-id>`.
`createListenerSupervisor` accepts an injected process port for component tests
and composition, and `nodeListenerProcess` is the Node child-process adapter.
The spawned argument vector contains only `listen`, `--binding`, and the binding
ID; no released or model-authored bytes enter arguments, environment variables,
errors, or retry observations.

## Composition boundary

The fallback executable is a runnable supervision surface, but delivery still
depends on an installed `khala` CLI with a live runtime composition. This
package proves lifecycle behavior and packaging, not that a provider route is
live. It therefore reports `support: "experimental"` with no fabricated
evidence reference.
