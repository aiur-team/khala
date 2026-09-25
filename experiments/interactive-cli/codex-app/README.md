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
- A **Blocked** cell reports `unknown` and cites no evidence. Every fact behind its
  reason must appear verbatim in the inventory.
- A **Proven** cell must cite an evidence file for the exact app version in the shape
  tuple. Its trial must meet all of these rules:
  - The user started the session before the trial. For a cloud cell, the user also
    created the task before the trial.
  - The boundary, model context, and acknowledgement all name that same session.
  - The process census shows no `codex app-server`, `codex exec`, `codex cloud exec`,
    `remote-control`, Responses or Agents API call, or Agents SDK run.
  - No message marker appears in any argv or environment.
  - A `steer` batch is enqueued while the tool runs. Delivery waits for the tool to
    finish, reaches model context, and only then is acknowledged. A hook firing alone
    does not pass.
  - After a restart, the unacknowledged batch replays and the acknowledged batch is
    never delivered again.

No Proven trial exists yet. The tests build one in a temporary copy so that the gate
is exercised.

## Reproduce

```sh
npm install
npm test
npm run typecheck
npm run verify:evidence
```

Each test was also run with its guarded line reverted in a scratch copy, and each one
then failed. The guards and their tests:

| Test | Guarded line in `verify.ts` |
| --- | --- |
| a missing cell is rejected | the `cell set` `deepEqual` |
| a blocked cell cannot claim support | `blocked cell must report unknown` |
| a blocked reason must cite captured inventory | `inventory fact not captured` |
| starting codex app-server cannot satisfy delivery | the `codex app-server/exec/cloud exec` pattern |
| an Agents API run cannot satisfy delivery | the `@openai/agents` pattern |
| a new cloud task cannot satisfy delivery | `cloud task created during the trial` |
| a cloud task Khala submitted cannot satisfy delivery | `cloud task was not created by the user` |
| a hook that fired without model context cannot pass | the required `modelContextAt` timestamp |
| delivery into a different session cannot pass | `session differs from the user's session` |
| aborting the active tool cannot pass | `delivered before the active tool completed` |
| a duplicate after restart cannot pass | `acknowledged batch delivered again after restart` |
| a lost unacknowledged batch cannot pass | `unacknowledged batch not replayed after restart` |
| a proof for another app version cannot pass | `app version differs from the shape tuple` |
| a message marker in argv cannot pass | `marker found in a process argv or environment` |

## Unblocking a cell

A Codex desktop cell needs a host where the native app installs. A cloud cell needs a
Codex Cloud task that the user already created, with Khala's hooks or remote MCP
server set in that task's environment. With either in place, follow the
[empirical proof procedure](../../../docs/product/internal-mode/interactive-desktop-apps.md#empirical-proof-procedure).
Commit the raw trial, then set the cell to `proven` with its `trial` fields. Change
`appVersion`, `accountTier`, and `administratorPolicyScope` in `shapes` to the exact
values observed.
