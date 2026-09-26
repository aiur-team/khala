# Codex app adapter (E09 `codex-app-channel-adapter`)

`inspectCodexApp(environment, limits)` from `@khala/harnesses/codex-app/index`
returns the `AppHarnessRecord` for one Codex desktop session (`local_chat`) or
Codex Cloud task (`cloud_task`). Khala never starts, hosts or aborts Codex here.

## Support row

Every mode is `unknown`. The [2026-09-25 proof record](../../../../experiments/interactive-cli/codex-app/README.md)
kept all six cells Blocked, because no native desktop app and no existing cloud task
were available. `CODEX_APP_PROVEN_CELLS` is therefore empty. A cell enters it only
when `evidence/cells.json` marks the same cell `proven` for the same exact tuple, and
`inspect.test.ts` fails on any disagreement.

A mode is `proven` only when all of these hold:

- A proven cell matches the full app/shape/version/account-tier/policy tuple. A
  cloud proof never matches a desktop session, and an unobserved field (`unknown`)
  never matches anything.
- The session passes the proof kit's process census (`census.ts`, the rules of
  `experiments/interactive-cli/codex-app/verify.ts`), taken from the observed
  process table rather than from anyone's claim. The session process and its
  ancestors must not include Khala. No Codex process in the session's tree
  (ancestors and descendants included) may bypass normal trust settings:
  `--yolo`, `--dangerously-bypass-approvals-and-sandbox`, `-a never`,
  `--sandbox danger-full-access`, or the equivalent `-c approval_policy=never` or
  `-c sandbox_mode=danger-full-access` overrides. A missing census fails closed.
  Conformance checks that `codexAppTrustBypass` agrees with the proof kit.
- For a cloud task, the task's own record says the user created it.
- For `steer` and `sync`, the Khala hook is configured where the shape runs it: the
  local Codex config for desktop, or the task environment for cloud. A web plugin
  install does not count. The handler must also have recorded running at that
  boundary in this session.
- For `steer`, the session's tools run on the hook host. A hosted tool skips
  `PostToolUse`, so an unknown or hosted execution fails closed.
- For `async`, the Khala MCP entry answers in the session.

`steer` uses only `PostToolUse`, so the running tool is never aborted. Hard abort is
not offered. `sync` uses `Stop`, with one continuation per turn. Until a cell is
proven, the `steer` and `sync` reasons state that idle agents receive messages only
at their next turn. Acknowledgement is `batch_token_next_call` only when some cell
is proven.
