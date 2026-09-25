# Codex desktop and cloud proof record

Captured on 2026-09-25 for `codex-app-channel-proof`.

## Result

All six Codex app cells are **Blocked**. Each one reports `unknown`, cites no evidence,
and has a concrete reason. None of them is a proven negative.

| App shape | `steer` (`PostToolUse`) | `sync` (`Stop`) | `async` (`khala_read`) |
| --- | --- | --- | --- |
| Codex desktop (`local_chat`) | Blocked: no native app installed | Blocked: no native app installed | Blocked: no native app installed |
| Codex Cloud task (`cloud_task`) | Blocked: no existing task | Blocked: no existing task | Blocked: no existing task |

- **Desktop.** No native Codex desktop app is installed on this Linux host.
  `ChatGPT.desktop` opens chatgpt.com in a browser wrapper. It is not the Codex
  desktop surface. Without the app there is no exact version or user-started session,
  and no hook timing to observe.
- **Cloud.** The CLI is logged in with ChatGPT, but `codex cloud list` returns
  `No tasks found.` The CLI's only way to get a task is `codex cloud exec`, which
  submits a new one. A new task is the contract's wrong implementation, so it was not
  run. The CLI also has no command to install hooks into a cloud task's environment.

The raw capture is [`evidence/host-inventory.txt`](evidence/host-inventory.txt). The
per-cell record is [`evidence/cells.json`](evidence/cells.json). The Codex CLI (0.154.0)
is listed only to tell it apart from the app surfaces. Its own proof is in
[`../codex/`](../codex/README.md) and counts for no app cell.

`codex cloud list` writes `error.log` into its working directory. That file holds the
ChatGPT account ID. It was deleted and is not committed.

## What the verifier enforces

`verify.ts` checks `cells.json` against the host inventory.

- The record has exactly the six cells: both shapes crossed with `steer`, `sync`, and
  `async`. Each cell uses its mode's hook boundary.
- No cell carries trial fields in `cells.json`. Every trial fact comes from the raw
  trial file that a Proven cell's `evidenceRef` names.
- A **Blocked** cell reports `unknown` and cites no evidence. Every fact behind its
  reason must appear verbatim in the inventory.
- A **Proven** cell cites a raw JSONL trial for the exact app version in the shape
  tuple. The trial must meet all of these rules:
  - Every event records the same session ID, app version, and exact launch command
    (decision 33). The launch command has none of decision 33's bypass flags
    (`--dangerously-bypass-hook-trust`, `--dangerously-skip-permissions`,
    `--dangerously-bypass-approvals-and-sandbox`, `--setting-sources`, `--port`),
    and neither does any `codex` process in the census. For a desktop cell, the launch
    command is the argv of the app process named by `appPid`.
  - The user started the session before the trial. For a cloud cell, the user also
    created the task before the trial.
  - The process census holds `pid`, `ppid`, and argv for each process. A hosted model
    session is a `codex` process with `app-server`, `exec`, `e`, or `remote-control`
    anywhere after the binary, so global options such as `-c` or `--profile` do not
    hide it. A Responses or Agents API call and an Agents SDK run also count. Such a
    process passes only when the desktop app started it, for example the app's own
    app-server backend, and no Khala process is in its parent chain. It fails if
    Khala started it, if it is orphaned, or if its parent is unknown.
  - No message marker appears in any argv or environment.
  - The first batch is delivered through the cell's hook boundary. A `steer` batch is
    enqueued while the tool runs. Delivery waits for the tool to finish, reaches
    model context, and only then is acknowledged. A hook firing alone does not pass.
  - For `steer` and `sync`, a second batch is enqueued while the session sits idle
    (decisions 34 and 37). It reaches model context and is then acknowledged, with no
    tool call or user prompt in between.
  - After a restart, a batch that was delivered but not acknowledged replays and is
    then acknowledged. A batch acknowledged before the restart is never delivered
    again.

No Proven trial exists yet. The tests build one in a temporary copy so that the gate
is exercised.

## Reproduce

```sh
npm install
npm test
npm run typecheck
npm run verify:evidence
```

Each rejection test was also run with its guarded line reverted in a scratch copy. It
passed before the revert and failed after it. The command for each was
`node --test --test-name-pattern='^<test name>$' test/verify.test.ts`. The guards and
their tests:

| Test | Guarded line in `verify.ts` |
| --- | --- |
| a missing cell is rejected | the `cell set` `deepEqual` |
| a blocked cell cannot claim support | `blocked cell must report unknown` |
| a blocked reason must cite captured inventory | `inventory fact not captured` |
| trial fields typed into cells.json are rejected | `carries trial fields in cells.json` |
| starting codex app-server from Khala cannot satisfy delivery | `khalaStarted` (the Khala parent chain) |
| an app-server the desktop app did not start cannot satisfy delivery | `appStarted` (the app parent chain) |
| app-server behind a global option cannot satisfy delivery | the subcommand search after the `codex` binary |
| exec behind a profile option cannot satisfy delivery | the subcommand search after the `codex` binary |
| cloud exec behind a config option cannot satisfy delivery | the subcommand search after the `codex` binary |
| an Agents API run cannot satisfy delivery | the `HOSTED_API` patterns |
| a new cloud task cannot satisfy delivery | `cloud task created during the trial` |
| a cloud task Khala submitted cannot satisfy delivery | `cloud task was not created by the user` |
| a launch command that bypasses approvals cannot pass | `launch command bypasses normal trust settings` |
| a bypassed codex process in the census cannot pass | `census process bypasses normal trust settings` |
| a trial without the launch command cannot pass | `launch command not recorded` |
| a launch command that is not the running app cannot pass | `launch command is not the running app process` |
| a hook that fired without model context cannot pass | the required model-context timestamp |
| delivery into a different session cannot pass | `session differs from the user's session` |
| delivery through a different hook cannot pass | `delivered through the wrong boundary` |
| aborting the active tool cannot pass | `delivered before the active tool completed` |
| steer without an idle-session trial cannot pass | `has no idle-session trial` |
| sync without an idle-session trial cannot pass | `has no idle-session trial` |
| an idle batch enqueued before the session went idle cannot pass | `idle batch was not enqueued while the session sat idle` |
| an idle batch delivered on a user's next turn cannot pass | `session was not idle before the idle batch reached model context` |
| a duplicate after restart cannot pass | `acknowledged batch delivered again after restart` |
| a lost unacknowledged batch cannot pass | `unacknowledged batch not replayed after restart` |
| a proof for another app version cannot pass | `app version differs from the shape tuple` |
| a message marker in argv cannot pass | `marker found in a process argv or environment` |

## Unblocking a cell

A Codex desktop cell needs a host where the native app installs. A cloud cell needs a
Codex Cloud task that the user already created, with Khala's hooks or remote MCP
server set in that task's environment. With either in place, follow the
[empirical proof procedure](../../../docs/product/internal-mode/interactive-desktop-apps.md#empirical-proof-procedure).

Commit the raw trial as a JSONL file. Each line is one event with `kind`, `at`,
`sessionId`, `appVersion`, and `launchCommand`. The event kinds are:

- `session_start`, with `startedBy` and, for a desktop cell, `appPid`
- `task_created`, with `createdBy` (cloud cells only)
- `trial_start`
- `census`, with `processes`
- `marker_scan`, with `hits`
- `tool_start` and `tool_complete`
- `idle` and `user_prompt`
- `enqueue`, with `batch` and a `phase` of `active`, `idle`, or `restart`
- `boundary`, with `batch` and `hook`
- `model_context` and `ack`, each with `batch`
- `restart`

`test/verify.test.ts` has a complete example. Point the cell's `evidenceRef` at the
file and set the cell to `proven`. Change `appVersion`, `accountTier`, and
`administratorPolicyScope` in `shapes` to the exact values observed.
