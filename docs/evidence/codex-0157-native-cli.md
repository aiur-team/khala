# Codex 0.157.1 native Sol sync preflight

On 2026-09-27, a disposable Linux x64 Codex CLI **0.157.1** TUI using the existing
ChatGPT account and exact **GPT-6-Sol** model completed a native sync exchange.
Codex itself showed the model, workdir trust prompt, and review of all four
installed Khala hooks. The operator trusted the private fixture folder and
those hooks through the normal TUI dialogs. The TUI and its app-server daemons
ran in one bounded local scope; its temporary auth copy was removed and the
scope was stopped after the run.

The production Codex setup adapter and transaction executor installed the
skill, hook commands, and MCP entry into a private `CODEX_HOME`. The installed
launcher used the production CLI read command and durable file inbox. The
fixture injected an exact held binding, effective `sync` mode, and local
control client; these are **not** evidence of hosted control or Matrix.

## Sync hook

A finite `READY` turn ended before delivery. The fixture durably enqueued one
synthetic release. Its independent check bound the TUI process, app-server
processes, private home, workdir, exact native session and Sol model. The
trusted hook placed that release in the next native turn. A model-originated
call to the installed `khala read --ack` used the current batch token, returned
success, and advanced the production inbox cursor to that release. The model
relayed only the synthetic released body. The sanitizer reported:

| Check | Result |
| --- | --- |
| Released batch visible in the bound native turn | true |
| Agent relayed released synthetic body | true |
| Same-session model call returned exact batch ACK | true |
| Durable inbox cursor advanced | true |
| Never-enqueued marker absent | true |

The last check is a transport-boundary check only. The marker was generated
but never enqueued, so this run does **not** prove filtering of a durable
pending neighbor. The full #42 crash/restart and pending-neighbor scenario
remains separate.

The ordinary Codex tool sandbox returned `EPERM` for Unix-socket bind at both
an owner-private state path (62 bytes) and the private fallback `/tmp` path
(46 bytes). This was observed in a model-originated diagnostic call. The
initial read therefore failed before ACK while `acquireListener()` opened a
wake socket. The corrected one-shot read uses a SQLite kernel transaction
lock without a wake socket; the real native run above used that path. A
permanent exact legacy marker fences older PID-based listener clients;
pre-existing legacy locks fail closed because a PID viewed across namespaces
cannot be safely reclaimed. Automated tests cover contention and recovery
after a killed lock holder.

## Queue idle

After the finite turn ended, the production queue process port invoked Codex
with the constant, content-free notice and an allowlisted environment. It
returned `queued`. The **same already-open TUI** began another model turn
without an operator prompt, its hook delivered the release, and the read/ACK
above completed. This establishes one observed immediate wake for exact
Codex 0.157.1 in `sync` mode. It does not establish indefinite idle behavior,
busy-turn ordering, `steer`, or `async`. A queue exit by itself is never used
as a payload or receipt claim.

The frozen source hashes for this passing run were `b4a5cebe` (inbox),
`f2ab53cc` (call consumer), `2c701956` (native fixture), `ff7b4e88`
(origin checker), and `c132446a` (rollout checker). The local sanitizer
produced only the five booleans above plus `passed: true`; raw rollout,
marker and token files stayed in the owner-private disposable directory.
The verifier's exact source and negative controls are under
`tests/integration/connector/native-sol-*`.

This is a local native preflight, not the #42 crash/restart acceptance run.
The 0.157.1 native hook capability is limited to Linux x64 by this proof.
The owner server uses the bound agent's authenticated platform and architecture report;
older reports without those fields remain unproven for 0.157.1.
It does not exercise live Synapse intake, hosted Dex, a distributed control
store, or paid infrastructure. Codex 0.154.0 on the same account previously
returned HTTP 400 for the exact Sol model; this run used the supported
0.157.1 client without changing model or account.
