# Claude idle-wake spike

Throwaway Node ESM plugin; inert unless this session has a spike inbox.
No Khala binary or product hooks are used. Logs contain ids/counts, never bodies.

```sh
node --test experiments/m1-idle-wake/claude/hook.test.mjs
claude plugin validate experiments/m1-idle-wake/claude/marketplace
claude plugin validate --strict experiments/m1-idle-wake/claude/marketplace/plugins/khala-wake-spike
```

Set `SPIKE` to this directory's absolute path. Executor coordinates installation
and all pane legs using `docs/build/m1/tickets/KM-111.md`; serialize with KM-112
and KM-151. Do not append to AGENT-MESSAGES during an idle quiet window.

```sh
node "$SPIKE/stub-inbox.mjs" init --harness claude --session "$ID" --channel spike
node "$SPIKE/stub-inbox.mjs" append --harness claude --session "$ID" --label Maya --kind human --body 'L2 marker abc123'
node "$SPIKE/stub-inbox.mjs" append --harness claude --session "$ID" --count 2 --gap-ms 300 --body 'L4 marker abc123'
node "$SPIKE/stub-inbox.mjs" log --harness claude --session "$ID" --since '2026-10-01T00:00:00Z'
```

Absolute `XDG_STATE_HOME` overrides `~/.local/state`; relative values fall back.
`init` refuses an existing inbox to preserve evidence. The watcher polls every
250 ms; `KHALA_SPIKE_WATCH_SECONDS` defaults to 4200. Plugin timeout is 7200.
Only synchronous delivery advances the cursor. Teardown removes the local plugin,
marketplace, and only the state directories explicitly created for this spike.
