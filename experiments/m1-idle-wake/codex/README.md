# KM-112 native queue spike

Disposable experiments only; do not install into a live home without Executor coordination.
Requires Node 22 and Python 3.11+ (TOML validation). No package build is needed.

```sh
node --test experiments/m1-idle-wake/codex/spike.test.mjs
node experiments/m1-idle-wake/codex/stub-inbox.mjs init --harness codex --session ID --channel spike
node experiments/m1-idle-wake/codex/stub-inbox.mjs append --session ID --body 'synthetic marker'
node experiments/m1-idle-wake/codex/waker.mjs --session ID --if-idle --once
node experiments/m1-idle-wake/codex/stub-inbox.mjs log --since ISO_TIMESTAMP
```

State is under `${XDG_STATE_HOME:-$HOME/.local/state}/khala/codex/ID`.
Only the synchronous hook advances the cursor. Tool hooks record busy activity.
The queue child inherits an allowlisted environment and a fixed notice.
Omit `--if-idle` only for the ticket's busy-queue characterization leg.
`install.mjs install|uninstall` uses `${CODEX_HOME:-$HOME/.codex}`.
Existing backup files prevent installation; unrelated edits prevent restoration.
The MCP probe deliberately logs to the default HOME state root to measure env mismatch.
Review spike hook trust in the normal TUI dialog; never bypass it.
Manual L0–L4, L3b and L7 require serialized Executor-mediated pane legs.
Use the issue's exact relay instructions and guard its quiet windows.
Keep backups until teardown and compare pre/post SHA-256 digests.
