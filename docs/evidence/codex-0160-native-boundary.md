# Codex 0.160.0 native hosted boundary

## 2026-10-01 isolated later-call recheck (#810)

An exact native `codex-cli 0.160.0` executable with SHA-256
`12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad`
ran in a new private home and workdir. A read-only link supplied provider auth;
the saved owner session and its configuration were untouched. With Codex's own
sandbox bypass enabled inside the externally restricted agent workspace, a
model-origin shell call completed with exit code zero and returned the requested
synthetic marker. The same pinned binary then started this checkout's bundled
Khala MCP server through invocation-only configuration. The model called
`khala_read`; the server returned `refused/not_connected`, as expected without a
channel binding. Raw rollouts and auth material are excluded from this record.

This narrows the earlier bubblewrap failure to that probe's sandbox execution
path. The bound-channel result below supersedes this unconnected call.

## 2026-10-01 bounded local manual read and ACK (#810)

The same pinned 0.160.0 binary (SHA-256 above) and a locally built Khala CLI
bundle (SHA-256 `a6fded7413118ef21447a43d300db750a1fa83073fc63d62442837751b0b8669`)
ran with private home, state, runtime, workdir, and provider-auth handoff. A
fresh internal channel used an isolated headless owner browser with no external
browser requests. The browser approved one Codex session and sent one fresh
human challenge. The native `codex exec` thread
`01a0f985-723b-75e2-9178-28bfa276132c` resumed under the same ID. On its
model-origin `khala_read`, Codex supplied `_meta.threadId` equal to that ID;
the generic Khala `mcp-serve` entry resolved the exact grant and returned the
challenge with a batch token. The model then made an independently intended
`khala_send` reply with exactly that token in `ackBatchToken`; the reply was
accepted and answered the challenge (`ine.`).

The owner read a durable `agent_acknowledged` receipt for event
`1f698095-33a3-40a3-a236-b411968f0fbe`, binding
`binding_5BjQ9DgfBsoKa553DbMpo5MQeACYaqEng79w7reG1xU`, generation 1.
The private inbox cursor advanced to offset 1256, and a later CLI read under
the same grant returned no batch. A generated marker never submitted to the
channel was absent from the model-visible read. The browser timeline contained
the model reply. Raw rollout, credentials, grant, and channel payload were
discarded after these sanitized facts were recorded.

The MCP child required explicit `XDG_STATE_HOME` and `HOME` in the private
invocation's `mcp_servers.khala.env` table. Without the private state root, the
generic entry returned `not_connected` even after owner approval; that probe
was an environment mismatch, not missing 0.160.0 `_meta.threadId`. This proof
used a disposable `codex exec` session with Codex's inner sandbox bypassed
inside the externally restricted workspace. It establishes local manual
model-origin read, later ACK/cursor, and reply for this exact session and
binding. It does not establish normal TUI hook trust, queue wake, Sync, Steer,
hosted routing, or production owner approval.

## 2026-10-01 normally trusted private TUI Sync proof (#810)

The pinned native 0.160.0 binary above started a private TUI session
`01a0f98b-5426-7822-a481-bd52e1211a91`. The operator reviewed and trusted
the four installed Khala handlers through Codex's normal hooks dialog. The
private installed Khala payload had SHA-256
`236ad87b72f58e53c5cfcf4d25692f68bc19c0fb8daf087b6b9559e2c37966ef`.
A private browser approved that exact session on channel
`ch_sFIknJJZjYGXEOSlnnizJQ`, binding
`binding_rkIQs38JtD75sOMFDTmaQ1Zg7k9Ldk0yEDrFl87669Y`, generation 1.
The local Sync capability gate was provisionally enabled solely for this
bounded test. A browser challenge caused an automatic content-free queued TUI
turn, and the hook placed the challenge and batch token in model-visible
context. The model's MCP call initially returned `not_connected`: the Codex
MCP child did not inherit this test's private `XDG_STATE_HOME`. Adding that
state root to the private `mcp_servers.khala.env` table and resuming the same
native thread restored the MCP connection. This temporary config edit is not
a shipped setup fix.

The first challenge was acknowledged by a later model-origin `khala_read` with
its exact batch token; its owner receipt linked event
`8827d395-f4e5-4e5f-84ae-fb46d1619387`. A fresh second browser challenge
then ran with the state-root pin already loaded and without another TUI
restart. The trusted hook auto-delivered it; the model's later `khala_send`
carried its batch token and replied `nce.`. The owner recorded a second durable
`agent_acknowledged` receipt for event
`e064dbae-28b3-4a11-bdc9-95ecac5cc772` on the same binding and generation.
The private inbox cursor advanced to offset 2536. No production room, saved
operator session, or external browser origin was used.

This is local, normally trusted TUI Sync timing plus retained ACK and reply
evidence for one exact native session. The route gate remains provisional
until the managed MCP environment fix and negative tests are reviewed. It does
not prove Steer timing, hosted admission, or owner-approved production behavior.

The 2026-10-01 recheck of the installed package and native binary returned the
same version and digest recorded below. The public launcher is a shell script
with a different digest and is not the executable pin.

2026-10-01, Linux x64. The installed `@openai/codex` package reported
`codex-cli 0.160.0`. The exact native executable had SHA-256
`12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad`.
The public `codex` command was a launcher that can resolve an npm package; this
probe invoked the pinned package executable directly so an update could not
change the version between commands. All active commands used a mode-0700
disposable Codex home and workdir with separate HOME, XDG_CONFIG_HOME, and
XDG_DATA_HOME. The probe used synthetic text and a read-only link to existing
auth; it did not inspect or change the owner's saved thread, desktop focus,
Khala binding, global install, or #787 releases. Raw rollout and auth material
are not included here.

## Earlier exact-version observations (#806)

| Contract | Observation | Claim allowed |
| --- | --- | --- |
| Native MCP configuration | `mcp list --json` parsed a disposable named server from `config.toml`. | Manual MCP setup can be inspected; no model-origin MCP call was proven. |
| Native hooks feature | `features list` reported `hooks` enabled. | Feature availability only; owner trust and Khala handler execution remain separate. |
| Queue command | `queue --thread --message` accepted the command shape and refused a deliberately nonexistent thread with `no rollout found`. | No same-session queued wake was observed. |
| Saved native process | A disposable `codex exec` session emitted `thread.started` and two `Stop` events; the second reported `stop_hook_active: true`. The synthetic Stop continuation made the model attempt a later shell call containing the offered marker. | Stop continuation and model-visible boundary observed for an exec session; this is not the normally trusted owner TUI route. |
| Later call and receipt | Both shell calls failed before execution while building a bubblewrap command: `app-server socket directory must be a user-owned directory with mode 0700`. A second run with a private 0700 XDG_RUNTIME_DIR had the same result. No Khala read or send was configured or completed. | No executed next call, authenticated binding/generation, inbox advancement, or correlated receipt. |

The disposable hook used the CLI's hook-trust bypass after local review of its
synthetic command. That demonstrates a native boundary, not normal owner trust.
The launcher failed when HOME was redirected because it tried to select an
uninstalled Node version; direct invocation of the immutable native executable
resolved that probe setup issue. The two failed shell attempts are an environment
limit and are **not** evidence that 0.160.0 removed later-call support.

## Gate result

0.160.0 remains typed unsupported for the hosted native route. The setup
absent-home exception is now admitted by this ticket's exact-version setup
change; setup still cannot certify delivery. Hosted session inspection can retain the exact
provider-named session label and generation while reporting unsupported
delivery. The hosted gate still excludes 0.160.0; `hosted-codex.ts` reports
`native_version_unsupported` before hosted promotion. The private manual MCP
journey proves read, exact-token later ACK, and reply for one bounded exec
session. The private TUI journey additionally proves local Sync hook and queue
timing, subject to a reviewed setup fix and negative tests. Steer, hosted, and
production remain unproven on 0.160.0.

The remaining local source boundary is managed MCP state-root inheritance:
Codex's child must resolve the same binding state as the trusted hooks. The
hosted route also requires exact-version admission and negative tests; Steer
and Async need their own boundary and receipt proof before their mode gates
change.

## Controlled owner handoff

For a later same-thread acceptance, pin an immutable 0.160.0 executable by
package version and SHA-256 above in the proposed bundle, together with exact
Khala artifact digests and the reviewed hook and MCP configuration. Reconnect
only an owner-selected saved thread after verifying its native session identity,
process executable, hook trust, binding ID, and generation. Run one release,
read, and exact-token ACK with correlation to that binding. If any check differs,
leave the route unsupported and do not send a second release. #787's separately
pinned 0.159.3 production proof and its live release/read/ACK gate remain
independent of this 0.160.0 observation.

## Precise unsupported finding and fallback

The earlier synthetic Stop continuation lacked an executed later call. The
bounded manual proof above now has one model-origin later-call receipt and
cursor advancement. The private TUI proof now supplies normally trusted hook
and exact queue-wake timing for local Sync. A
hosted-route regression test verifies that a claimed positive hook result
cannot promote 0.160.0 without its native queue contract. The safe fallback is
the separately pinned 0.159.3 native route in
`codex-0159-3-native-sync.md`, subject to its own owner gate. Do not change the
user's installed binary automatically.

PR #808 defines the broader cross-mode acceptance journey. This finding covers
only the exact 0.160.0 Codex native route; #787 remains the sole writer of the
0.159.3 production dispatcher until its handoff.

## Immutable reconnect bundle

Capture a read-only bundle manifest with SHA-256 digests for the exact checkout
and binary used in each proof. These values pin this checkout; regenerate and
review the manifest if any file changes. The bundle contains no auth token,
room key, or rollout.

| Artifact | SHA-256 |
| --- | --- |
| Codex 0.160.0 native Linux x64 binary | `12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad` |
| `packages/agent-cli/src/codex/hook.ts` | `8d5ee5dfca60b0498032cb7afcc2c31a647c43a5e4f07e81b7965a93c8b73f62` |
| `packages/agent-cli/src/codex/hooks-config.ts` | `63958fd6c9f773560794453c3fc3892a68c3af758384256a03b37dd58342a2ce` |
| `packages/agent-cli/src/composition/codex-installed-wake.ts` | `dc4efd8e33fe3074f70b26603aa3bc85d62018c4ced1dc640c2e40e6611f068d` |
| `packages/agent-cli/src/composition/read.ts` | `89c539acf2842967a0a51df2e2c26f0e04157690ab6977579239ed8c08d7593c` |
| `packages/agent-cli/src/cli/inbox.ts` | `c826794a13bb93f2b21b6cd06f441d5e0961c7ed4b5c0dc94cf3f70034cbf6d7` |

For a fresh bounded local test, verify these digests, use private HOME/XDG
directories, review and trust the exact Khala hook, and hold one test
binding/generation on one provider thread. Record the thread ID and executable
digest before release. Send one content-free queue notice, then one released
marker while retaining an unsubmitted marker. Capture the model's later
`khala_read` and `khala_send` results on that same thread, the exact returned
batch token, cursor advancement, and correlated receipt. A wrong thread, stale
generation, absent trust, revoked binding, duplicate token, or late receipt
must leave delivery unavailable. After reviewed merge and deployment, the owner
can repeat the bounded proof in production with explicit approval and an
owner-selected room. Local Sync timing and receipt evidence is recorded above;
Steer and production still need separate timing and receipt evidence.
