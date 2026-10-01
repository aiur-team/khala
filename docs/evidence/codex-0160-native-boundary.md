# Codex 0.160.0 native hosted boundary

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

## Exact-version observations

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

0.160.0 remains typed unsupported for the hosted native route. Setup's
absent-home exception does not include it, although an existing home may pass
direct MCP and hook probes. Hosted session inspection can retain the exact
provider-named session label and generation while reporting unsupported
delivery. The native queue and interactive hook gates still exclude 0.160.0;
`hosted-codex.ts` therefore reports `native_version_unsupported` before any
hook promotion. Manual `khala_read` / `khala_send` availability cannot be
inferred from version, MCP listing, or a synthetic shell attempt. Steer, Sync,
Async, and `batch_token_next_call` have no 0.160.0 native proof.

The smallest missing contract for promotion is one pinned, normally trusted
0.160.0 TUI session with a held test binding and generation: a content-free
native queue notice must wake that exact session; the installed Khala Sync hook
must deliver one released marker; a model-origin later `khala_read` must return
the offered token on the same binding/generation, advance the inbox, and record
a correlated receipt while an unsubmitted marker remains absent. Steer and Async
need their own boundary and receipt proof before their mode gates change.

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

The missing contract is a model-origin later-call receipt. The synthetic Stop
continuation attempted a later call, but the sandbox refused it before
execution. No exact-token ACK or inbox cursor movement was witnessed. A
hosted-route regression test verifies that a claimed positive hook result
cannot promote 0.160.0 without its native queue contract. The safe fallback is
the separately pinned 0.159.3 native route in
`codex-0159-3-native-sync.md`, subject to its own owner gate. Do not change the
user's installed binary automatically.

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
owner-selected room. Steer and Sync need separate timing and receipt evidence;
a manual read/send result cannot promote either mode.
