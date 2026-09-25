# Interactive Codex CLI experiment

This throwaway fixture proves `steer`, `sync`, and `async` delivery, the idle
wake, and restart safety inside an interactive Codex TUI. It runs under **normal
trust settings**: the host user's real `~/.codex`, a plain `codex` launch, and
no `--dangerously-*` flag. The TUIs were **agent-launched with default
settings** (the Aiur agent started them; no human did). Khala never hosts
Codex, an app-server, or an SDK agent.

| File | Role |
|---|---|
| `setup-fixture.ts <project>` | Writes the four proof hooks into `<project>/.codex/hooks.json` and the skill stand-in (`AGENTS.proof.md`) into `<project>/AGENTS.md`. Codex's own folder-trust prompt and hook review still gate them. |
| `bridge.ts` | Hook handler plus the agent's `read [--ack TOKEN]` Khala call. Emulates the future shared pull and batch-token contracts. Logs session, turn, the observed Codex argv, and the binary's `--version` on every event. |
| `drive.ts` | Khala side. Enqueues a body from stdin mid-tool or at once, optionally sends the fixed `codex queue` wake, and optionally SIGKILLs Codex right after an offer. |
| `watch-proc.ts` | Polls `/proc` every 5 ms during a trial. It records every live hook, read, and wake process and checks every process's argv and environment for the message markers, which it reads on stdin. |
| `verify.ts` | Cross-checks `live-run.json` against the raw events, rollout excerpts, and process captures. |

## Evidence

- [`launches.json`](evidence/launches.json): exact launch and resume commands,
  versions, sessions, and the one-time approvals (folder trust, hook review).
- [`hook-trust.toml`](evidence/hook-trust.toml) and [`screens/`](evidence/screens/):
  the persisted `trusted_hash` records and the TUI review screens.
- [`events-0.154.0.jsonl`](evidence/events-0.154.0.jsonl),
  [`events-0.156.1.jsonl`](evidence/events-0.156.1.jsonl): complete raw fixture
  logs, including tool starts, arrivals, every hook, offers, reads, wakes, the
  kill, and acknowledgements.
- [`rollout-excerpts.jsonl`](evidence/rollout-excerpts.jsonl): when each batch
  entered the model's context in Codex's own session rollout, and when the model
  relayed the message marker.
- [`proc-0.154.0.json`](evidence/proc-0.154.0.json),
  [`proc-0.156.1.json`](evidence/proc-0.156.1.json): live process captures.
  The first window (00:38–01:03 UTC) spans every 0.154.0 trial and most
  0.156.1 trials. The second (00:49–01:14 UTC) spans every 0.156.1 trial. A full
  `/proc` scan takes about 50 ms, so some short-lived hooks finish unobserved;
  each file lists the processes it caught.
- [`live-run.json`](evidence/live-run.json): the per-cell summary.

Host paths are written as `~`.

## Reproduce the deterministic checks

```sh
npm install
npm test
npm run typecheck
npm run verify:evidence
```

The bridge is evidence code, not production code. Production must consume the
shared Khala session binding, capability, channel pull, and batch-token
contracts instead of copying this file.
