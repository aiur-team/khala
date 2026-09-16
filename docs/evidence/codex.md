# Codex existing-session attachment: blocked proof

**2026-09-16 — inconclusive; KHA-104 remains incomplete.** No live nonce was sent.
The installed CLI exposes promising queue/proxy primitives, but this agent cannot
reach a designated disposable existing session. Neither AE1 nor AE2 has passed.
This is an environment-specific observation, not a claim that Codex cannot attach.

## Reproducible evidence

- [Inventory and raw/sanitized hashes](../../experiments/codex/evidence/inventory.json):
  `@openai/codex` / `codex-cli` **0.154.0**, Node **24.18.0**, Linux x64.
  Binary entrypoint came from the mise-managed npm installation.
- [Actual read-only preflight report](../../experiments/codex/evidence/preflight.json):
  current ticket session UUID supplied explicitly, `release:false`, proxy exited
  before initialization. No native observed UUID, queue receipt or consumption.
  Its `busy` field is requested mode, not observed busy-delivery evidence.
- [Proxy failure](../../experiments/codex/evidence/inventory-4.txt): default control
  socket `<HOME>/.codex/app-server-control/app-server-control.sock` did not exist.
- [Fixture startup failure](../../experiments/codex/evidence/inventory-5.txt):
  `codex app-server --stdio` could not initialize SQLite under read-only Codex home.
  A Unix-listener startup also failed with read-only filesystem before any target
  existed. No home/config rewrite, credential copy or permission change was tried.
- [Isolated runner and instructions](../../experiments/codex/README.md).

Official reference checked 2026-09-16:
[Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
Installed experimental schema is the authority for this experiment's wire shapes;
documentation or a schema field's presence alone does not prove live attachment.
No open-ended minimum version support claim is made.

## Route inventory

| Route | Installed evidence | Unproven assumption / decision |
|---|---|---|
| `codex queue --thread … --message …` | 0.154.0 help exposes explicit thread and remote transport | Not invoked for live send. Help does not prove executor preservation; message arguments also expose text to process listings. |
| `codex app-server proxy` + `thread/queue/add` | Generated params require `threadId`, `clientUserMessageId`, `input`; response includes `queuedSubmission` | Preferred **candidate**, not recommendation. No reachable default socket here; client ID is not proof of deduplication. |
| `thread/read` metadata | Generated protocol supports `includeTurns:false` and reports native ID/model/cwd/runtime input capability | Metadata alone cannot prove executor identity, permission state or consumption. Probe withholds history. |
| `turn/steer` | Installed params include `threadId`, `expectedTurnId`, `input` | Not demonstrated on an arbitrary existing CLI session; busy input must not interrupt tools. |
| New app-server + resume/start | CLI can launch an app server, but local startup failed | A new/resumed executor is never a qualifying replacement for the existing working session. AE2 live negative control remains blocked. |

## Receipt interpretation and scenario matrix

The runner can observe proxy initialization, a metadata read, a queue request attempt,
a native queue response and post-queue metadata. Its monotonic timestamps share one
probe process clock. No transport service or connector is involved, so published,
connector-received and durable-accepted timestamps are absent, not fabricated.
Request-attempt time precedes the local write; it must not be labeled notification
write or native acceptance. No native response means delivery uncertainty once an
attempt has begun; never turn that into a rejection or retry automatically.

| Required scenario | Actual result | Remaining gate |
|---|---|---|
| Idle nonce + prior marker under original executor | Not run | Reachable designated fixture, native identity/settings and consumption observers |
| Busy controlled tool | Not run | Tool/queue/consumption timeline without interruption |
| Client disconnect after write | Fake-process test only | Native acceptance reconciliation; no blind replay |
| Duplicate/resume negative control | Guarded against invoking these routes; live case not run | Demonstrate rejection using actual executor identity, even for copied history |
| Target exit | Not run | Exit designated fixture and verify attachment creates no replacement |

## Local implementation validation

`npm --prefix experiments/codex ci`, help, strict TypeScript typecheck and the
experiment's tests validate the runner independently. Tests collect real assertions
against fake subprocesses: request correlation, UTF-8 fragmentation, malformed and
oversized responses, process exit, deadline/SIGKILL cleanup, input/identity/workdir
refusal, no history reads, conservative receipt classification, no automatic retries,
and omission of private metadata/errors from reports. These are not model proof.

## Handoff to KHA-106 and KHA-118

No production support claim is released. KHA-106 may use only the distinction between
request attempt, queue receipt and unobserved consumption. KHA-118 may inspect the
pinned queue schema and explicit failure behavior, but must not enable attachment
based on this result. Proxy exit is a preflight failure here; after an input attempt,
transport exit/deadline is ambiguous. Structured raw server errors are withheld from
published reports. A future adapter still needs safe error-code classification,
permission/process binding, consumption observations and reconciliation proof.

Smallest remaining operational requirement: a reachable, explicitly designated
**disposable existing session** under the permitted runtime, preserving native ID,
workdir, model and effective permissions. Fixture access must not require human
connector installation, credential switching or broader sandbox permissions. If
this cannot be supplied, an explicit acceptance decision is needed before treating
this partial evidence as a completed negative research result. Until then U2–U4 and
human-review readiness remain blocked; repository Write access is separately pending.
