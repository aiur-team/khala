# Interactive Codex CLI experiment

This throwaway fixture proves delivery boundaries in a **user-started Codex
TUI**. It does not run an agent on Khala's behalf. `setup-fixture.ts` installs
four native Codex hooks into an isolated `CODEX_HOME`; `bridge.ts` emulates the
future shared Khala pull and batch-token acknowledgement contracts.

The two live PTY runs covered the installed 0.154.0 and then-current npm 0.156.1
versions. The raw, selected JSONL events are in [`evidence/`](evidence/), and
[`live-run.json`](evidence/live-run.json) pairs arrivals with observed delivery
and acknowledgement timestamps. Message bodies were sent to `enqueue` on
stdin. [`argv-safety.json`](evidence/argv-safety.json) records a live `/proc`
capture of the adapter command line and environment while the stdin pipe held a
unique marker; neither contained the marker. Hard abort was disabled.

## Reproduce the deterministic checks

```sh
npm install
npm test
npm run typecheck
npm run verify:evidence
```

The live TUI itself was started by the user under a real PTY with an isolated
`CODEX_HOME`, `KHALA_FIXTURE_DIR`, and the hook-trust bypass used only for the
experiment. A 20-second Bash sleep provided the busy-tool window. The fixture
then enqueued batches from a separate process and inspected the native hook
event log. The interactive session—not a background app-server—read and
acknowledged the batches.

The bridge is evidence code, not production code. Production must consume the
shared Khala session binding, capability, channel pull, and batch-token
contracts instead of copying this file.
