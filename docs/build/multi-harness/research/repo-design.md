# Repo design research: one adapter per harness (origin/main 825b365d)

Scope: where the code branches on the harness today, whether the hosted and local servers can accept an open harness id, how session ids reach the MCP server, the conformance-suite shape, and the release hazards. All paths are at `origin/main`. "R" means move it into a shared **registry** in `@khala/contracts` (pure data). "A" means move it into an **agent-side adapter** in `packages/agent`.

## 1. Every harness switch

### Contracts (the source of the closed list)
| Site | What | Target |
|---|---|---|
| `packages/contracts/src/m1/agent-join.ts:4` | `type Harness = 'claude'\|'codex'\|'cursor'` | R: `type HarnessId = string` (branded) plus `KnownHarness` |
| `agent-join.ts:46` | `HARNESSES` tuple | R: `HARNESS_REGISTRY` plus `HARNESS_ID = /^[a-z][a-z0-9-]{1,23}$/` |
| `agent-join.ts:61-62` | `readHarness` = `literal(…, HARNESSES)`, used by `decodeAgentJoinRequest` :111 and `decodeAgentJoinView` :163 | R: pattern check, not literal |
| `participants.ts:50,87` | `decodeAgentOwnerRecord` and `readParticipant` call `readHarness` | R (follows readHarness) |
| `local.ts:228,487,505` | local wire member content, summary members and `/members` call `readHarness` | R, **but see §2 compat** |
| `names.ts:16` | `agentSuffix = /-(?:claude\|codex\|cursor)…/`, which reserves username suffixes | R: built from registry `modelName`s |
| `names.ts:29-35` | `MODEL_NAMES` record; `defaultAgentName` and `isDefaultAgentName` | R: `modelName(id)` with fallback |
| `delivery/listening-mode.ts:6`, `m1/listening-mode.ts:8` | modes `steer/sync/async`, default `sync` | R: per-harness `capabilities` decides which modes are honoured |

### Control plane (apps/control)
| Site | What | Target |
|---|---|---|
| `apps/control/src/agent-join/agent-routes.ts:48` | rejects a harness outside `HARNESSES` with `invalid_harness` | R: `isHarnessId()` |
| `agent-join/store.ts:41` | a stored `JoinRecord` with an unknown harness decodes to `null` (treated as corrupt) | R |
| `agent-join/human-routes.ts:159`, `names.ts:12`, `rename.ts:197,201` | `defaultAgentName(username, harness)` | R via `modelName()` |
| `composition/human/matrix.ts:474` | forwards `agent.harness` into the participants payload | no change (passthrough) |

### Agent package
| Site | What | Target |
|---|---|---|
| `src/join.ts:59` | `requestJoin` rejects ids outside `HARNESSES` | R |
| `src/local/routes/agent-join.ts:44` | helper rejects with `invalid_harness`; :50,59-60 build the default name | R |
| `src/local/routes/profile.ts:31-48`, `local/identity.ts:12-17` (`MODEL_NAMES[harness]` regex) | rename and hosted-username recovery | R |
| `src/state.ts:48-50` | `sessionFiles` validates against `HARNESSES`; the state dir is `<root>/<harness>/<sessionId>` | R (pattern; already path-safe) |
| `src/mcp/session-id.ts:4-14` | `resolveHarness`: `--harness`, then `KHALA_MCP_HARNESS`, else claude if `CLAUDE_CODE_SESSION_ID` is set, else codex | A: registry lookup, plus each adapter's `detect(env)` |
| `src/mcp/session-id.ts:21-23` | session id per harness: claude reads env, cursor hashes the workspace, codex reads `_meta.threadId`, falling back to `CODEX_THREAD_ID` | A: `adapter.sessionId(meta, env)` |
| `src/mcp/wiring.ts:12-13` | `createCodexWaker` only for codex | A: `adapter.waker?(files, sessionId)` |
| `src/mcp/tools.ts:48,51` | description hardcodes `<Claude\|Codex>`; label falls back to `MODEL_NAMES[harness]` | R |
| `src/client-impl.ts:51` (+`cursor.ts:11`) | `cursor-default` is not rejoinable | A: `adapter.rejoinable(sessionId)` |
| `hooks/deliver.ts:85,89` | argv check against 3 ids; cursor goes to `deliverCursor` | A: `adapter.deliver` codec |
| `hooks/deliver.ts:90-127` | Claude/Codex stdin shape and envelope (`decision:block` / `hookSpecificOutput`) | A: shared "claude-style" codec |
| `hooks/deliver.ts:135-200` | Cursor event names, `followup_message`/`additional_context`, `loop_count`, BOM, `workspace_roots` | A: cursor codec |
| `hooks/claude-wake.ts:56` | hardcodes the `khala/claude/<session>` path | A: claude waker |
| `src/wake/idle-wake.ts:8,25`, `wake/codex.ts:19-61` | `codex queue --thread` waker | A: codex waker |
| `src/cli-bundle.ts:5-8` | hook table `deliver`, `claude-wake` | A: adapters contribute hook entries |
| `src/cli.ts:21`, `install/main.ts:10,95-127,119,127` | usage text and `install codex\|cursor` dispatch | A: `adapter.install?` |
| `src/install/cursor.ts:11-12,55,62,77` | Cursor paths, hooks and mcp.json | A |
| `codex/hooks-config.mjs:6`, `hooks/hooks.codex.json` | Codex hook fragment | A (codex) |
| `claude-plugin/khala/.mcp.json:1`, `hooks/hooks.json:7-14`, `hooks/hooks.claude.json` | `--harness claude` | A (claude); **hash-pinned (see §5)** |
| `scripts/smoke-package.mjs:91-109`, `npm/package.json:4,17-18` | install smoke test; description and keywords | A / docs |

### Web app (apps/web)
| Site | What | Target |
|---|---|---|
| `features/channel/roster-model.ts:52`, `features/timeline/attribution.ts:64,67` | two copies of `HARNESS_NAMES` | R: `displayName(id)` |
| `features/agent-confirm/AgentConfirm.tsx:15,34` | a third `harnessNames` copy, plus the logo | R |
| `features/channel/AgentPresencePanel.tsx:116,131`, `ChannelScreen.tsx:144` | renders `HARNESS_NAMES[agent.harness]` | R |
| `ui/khala/identity.ts:6-7,106-110` | `harnessLogo` handles claude and codex; every other id gets `null` (initials) | R: `logoKey` in the registry; the asset map stays in the web app |
| `ui/khala/MentionChips.tsx:22,74`, `MentionPopup.tsx:19`, `ui/conversation/ConversationList.tsx:49`, `TimelineScreen.tsx:523` | literal union / logo lookup | R |
| `features/channel/members.ts:42`, `composition/local/fake-local-helper.ts:42,282` | `Harness` type; the fake helper's literal union | R |
| `ui/khala/identity.test.ts:55` | already asserts `harnessLogo('gemini') === null` | keep |

### Docs
`docs/settings.md:12,23,32,36,60,76`: the harness list, the wake caveat, the reserved suffixes and the default-name examples. `packages/agent/README.md:7-12,34`, `npm/README.md:3-27`, `docs/install-{claude,codex,cursor}.md`. `apps/web/src/landing/public/AGENTS.md:7,10,29,83`: the supported list and the Cursor deeplink, whose version is rewritten by `sync-release.mjs:50-53`. Generate the per-harness doc table from registry `capabilities` where practical.

### Frozen compat copies (do not edit, see §5)
`src/compat/control-join-request.main.frozen.ts:17`: `claude|codex` only (production at 120d9ffa). `src/compat/helper-join-request.main.frozen.ts:9-19`: `claude|codex|cursor`. `src/compat/local-decoder.main.frozen.ts:6`: imports **live** `readHarness` from contracts. `src/compat/matrix-message.main.frozen.ts`.

### Tests that enumerate harnesses
`local/routes/agent-join.test.ts:133` (`it.each(['claude','codex','cursor'])`) `hooks/deliver.test.ts:24,121,288-345` `cursor.test.ts:20-23`, `install/cursor.test.ts`, `client-impl.test.ts:550-556`, `join.test.ts:52-53` `local/fixtures/e2e-harness.ts:110,161-163` (codex `_meta` branch; Claude-shaped hook stdin), `fixtures/no-egress-agents.ts:33-45` `apps/control/.../agent-routes.test.ts:164-170`, `web/.../attribution.test.ts:14`

## 2. Q5: a generic control plane (accept any `/^[a-z][a-z0-9-]{1,23}$/`)

**Mechanically yes.** Validation sits at the 6 sites in §1 that use `HARNESSES` or `readHarness`. All of them can switch to one `isHarnessId`. The ids are already path-safe for `state.ts:50`, and there is precedent in `experiments/ownership/src/binding.ts:63` (`/^[a-z][a-z0-9-]{1,31}$/`).

What breaks if only validation is opened:
1. **`MODEL_NAMES[unknown]` is `undefined`.**
   - `defaultAgentName` would produce `kevin-undefined` (`names.ts:31`, `human-routes.ts:159`, control `names.ts:12`, helper `agent-join.ts:59`).
   - `tools.ts:51` would send an undefined label.
   - `identity.ts:13` would build a `-undefined` regex.
2. **Name length.** `AGENT_NAME_MAX` is 40 and `USERNAME_MAX` is 24 (`names.ts:8-10`). `username-Model-NN` therefore leaves the model name at most 12 chars. A 24-char fallback fails `checkName`. The helper then returns 503 `unavailable` (`agent-join.ts:50`) and control's `allocateAgentName` returns `null`.
3. **`agentSuffix` (`names.ts:16`).** Unknown ids are simply not reserved, so a human may take `kevin-gemini`. The agent default then falls to `-2` through the `nameKey` collision (`names.ts:28`). This is acceptable. Build the regex from the registry's known `modelName`s and **never** from the open pattern, which would block legitimate usernames.
4. **Web rendering.** `HARNESS_NAMES[id]` gives "undefined agent" (`attribution.ts:67`), and `harnessName` (`AgentPresencePanel.tsx:131`) has the same problem. The logo already degrades to initials (`identity.ts:109`; Avatar documents `null`).
5. **Strict decoders reject before render.**
   - The web calls `decodeParticipant` (`browser-api.ts:335`) and `decodeAgentJoinView` (:382).
   - Control calls `decodeAgentOwnerRecord` (`rename.ts:82,106,146,194`, `matrix.ts:194`).
   - **Deploy order:** web and control with the open decoders first, then any CLI that emits a new id.
   - **Rollback is unsafe:** once records exist, a closed-list control nulls them (`store.ts:41`) and rename breaks.
6. **Local helper wire compat. This is the hard one.** One helper serves every CLI version (`wire-compat.test.ts:17-21`). Old CLIs decode `/events` member content with the closed `readHarness` (`local.ts:241→228`, used by `local/session.ts:142,170`). A member event carrying `harness:"gemini"` fails the page. Because "a rejected /events page is retried forever", every old agent in that channel goes silent.
   - **Mitigation:** by default the helper emits `harness` only for the legacy ids `claude|codex|cursor`. It omits the field for others; `harness` is optional at `local.ts:222,483,494`. A `?wire=2` param or an `X-Khala-Wire: 2` header from new CLIs and the new web returns the real id.
   - The frozen decoder also has to become truly frozen: inline the 3-id literal in place of the live `readHarness` import (`local-decoder.main.frozen.ts:6`). Otherwise `wire-compat.test.ts` would silently pass once `readHarness` is widened.
7. **Old helper, new CLI.** The frozen helper validator returns 400 `invalid_harness` (`helper-join-request.main.frozen.ts:19`), but `join.ts`'s single fallback fires only on `invalid_link` (`join-request-compat.test.ts:10-14`).
   - Fix: when `invalid_harness` comes from the local helper, restart it. `ensureHelper` currently checks only the pid (`wire-compat.test.ts:18`), so it needs a version or capability probe.
   - Against an un-deployed hosted control, surface `invalid_harness` as "update required".

**Proposed fallback (registry `harnessInfo(id)`):**
- `displayName`: registry value, else title-cased id (`copilot-vscode` → "Copilot Vscode").
- `modelName`: registry value (≤12 chars, enforced by a registry test), else `'Agent'`.
- `logoKey`: registry value, else `null` (generic initials avatar, already supported).
- `capabilities`: `{steer:false, sync:false, idleWake:false}` for unknown ids.

**Against using the join `label`:** the label is agent-supplied and documented as "Optional and ignored" (`tools.ts:48`). Control overwrites it at confirm (`human-routes.ts:159`). Persisting it as a harness display name would need a new key in `AgentOwnerRecord` (`participants.ts:43`, strict key list) and in local member content, which is the same compat cost as item 6. It also lets an agent pose as "Claude Code". A client-side title case needs no wire change. Recommendation: registry, then title case; do not use the label.

## 3. Q4: session-id plumbing

Today `resolveSessionId` (`mcp/session-id.ts:16-25`) works as follows:
- **claude:** `CLAUDE_CODE_SESSION_ID`, inherited by the MCP child.
- **cursor:** `cursorSessionId(KHALA_CURSOR_WORKSPACE)`, the sha256 of the workspace that `${workspaceFolder}` expands to in mcp.json (`install/cursor.ts:62`). With no folder it is `cursor-default`, which is shared and not rejoinable (`cursor.ts:4-11`, `client-impl.ts:51`). Hooks recover the same id from `workspace_roots[0]` (`deliver.ts:139-147`).
- **codex:** `_meta.threadId` on each `tools/call` (`mcp/server.ts:157-161` splits `_meta`), falling back to `CODEX_THREAD_ID`.
- **Validation:** the result must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` (:24, same as `validAgentSessionId`, `agent-join.ts:100`). Returning `null` makes the tool fail. Clients are cached per session id, so one MCP process can serve many sessions (`mcp/main.ts:38-49`).
- **Harness selection:** `KHALA_MCP_HARNESS` only selects the harness (:12). It carries no session id.

Proposal: an adapter declares an ordered `sessionSources` list, and the resolver tries each in turn.
1. **`meta`.** The adapter names a `_meta` key (codex: `threadId`). This is best when the client sends it, because it works per call.
2. **`env`.** A harness-native var (claude: `CLAUDE_CODE_SESSION_ID`), or `KHALA_SESSION_ID` injected by our plugin or extension. VS Code-style extensions (copilot-vscode) and Gemini/Qwen extensions can template env into the MCP server entry. This is per process, so it is only correct if the host spawns one MCP child per session.
3. **`hook-map`.** The first hook of a session (prompt submit) writes `<state>/<harness>/by-pid/<harnessPid>.json = {sessionId, at}`. The MCP child walks its ancestors (`process.ppid`, then `/proc/<pid>/stat` or `ps -o ppid=`) until it finds a map entry.
   - Caveats: a hook may run under an intermediate shell, so record the nearest non-shell ancestor. Windows needs a different walk. A tool call before the first hook gets `null`, so the tool should say "send a message first". Stale entries need a start-time check against pid reuse.
4. **`workspace`.** The Cursor-style hash (one identity per window), marked `rejoinable:false` when it falls back to a default.
5. **`generic` tier.** No hooks. Use `KHALA_SESSION_ID` if present, else `proc-<ppid>-<starttime>`, marked not rejoinable. This tier gets read, send and status only; listening mode is effectively async.

Rule: an adapter must say which sources give a per-conversation id (rejoinable) and which give a per-window or per-process id (non-rejoinable), and the client-impl rejoin flag reads that (replacing `client-impl.ts:51`).

## 4. Conformance suite

Infrastructure to reuse:
- **`local/fixtures/e2e-harness.ts`** `createWorld` (:119-148): temp XDG state, guarded env, fake `codex` bin logging argv (:123-125), local web build. `McpProcess` (:52-117): spawns `bin mcp --harness X` and drives JSON-RPC `tools/call`. `deliver()` (:161-166): spawns `hook deliver` with stdin. `armClaudeWake` (:168). `cli`, `admin`, `raw`, and `codexCalls` (:158).
- **`local/acceptance.e2e.test.ts`:** an AE1–AE12 runner with a results table (:100-134), gated by `KHALA_LOCAL_E2E=1` (:117). Joins (AE1-2), attribution (AE3), idle wake (AE4-5), modes at hook boundaries (AE6), rename (AE7), reconnect without replay (AE8), egress (AE10).
- **`hooks/deliver.test.ts`:** an in-process `hook(event, harness, extra, stdin)` helper (:24) with exact-frame assertions (:51-129), plus the cursor block (:288-345).
- **Wake tests:** `wake/codex.test.ts`: fake port, debounce, 2-per-cursor cap, async suppression (:42-168). `hooks/claude-wake.test.ts`: watcher timing and async (:58-192).
- **Install tests:** `install/cursor.test.ts`: paths, merges, deeplink. `install/main.test.ts`: codex toml and hooks. `scripts/smoke-package.mjs`: install, reinstall, uninstall.
- **Hosted join:** `client-impl.test.ts` (`joinApi` fake, :550). `join.test.ts` (`fetch` deps). Control `agent-routes.test.ts` (`f.handlers.create`, :164). `compat/join-request-compat.test.ts` (frozen validators).

Shape: `packages/agent/src/harness/conformance/` with `runConformance(adapter, driver)`, called once per registered adapter by `conformance.test.ts` (Tier A) and `conformance.e2e.test.ts` (Tier B).

```ts
interface FakeHarnessDriver {
  newSession(): { id: string; mcpEnv: NodeJS.ProcessEnv; mcpMeta?: Record<string, unknown> }; // how the MCP child sees it
  hookStdin(ev: 'prompt'|'tool'|'stop', s: { id: string; continuation?: boolean; workspace?: string }): string;
  readHookStdout(stdout: string): { kind: 'context'|'continue'|'none'; frame?: string };   // decode adapter envelope
  installInto?(home: string): Promise<void>;           // golden-file check of written config
  wakeProbe?: { fakeBin?: { name: string; script: string }; observed(world: World): Promise<boolean> };
}
```

- **Tier A (in-process, every PR):**
  - Session-id resolution for each declared source, including the hook-map with a fake pid tree.
  - Deliver codec: frame, `you=` attr (`deliver.ts:33-37`), event-only Stop, 50-entry cap, steer/sync/async gating.
  - Install merge idempotence and uninstall.
  - Waker policy against a fake port.
- **Tier B (spawned, `KHALA_LOCAL_E2E`):** generalise `McpProcess.start(world, adapter, driver)`. Replace the codex `_meta` branch (:110) with `driver.newSession().mcpMeta`, and the Claude-shaped `deliver()` stdin (:163) with `driver.hookStdin`.
- **Feature matrix:** each row is asserted, or asserted absent when `capabilities` says unsupported.

| Feature | Assertion |
|---|---|
| join (local) | AE1-style: the `khala_join` self link reaches `connected`; the roster has `kind:'agent', harness:id` and the default name `kevin-<modelName>` |
| join (hosted) | `requestJoin` against the control `agent-routes` handler (pending → confirm → poll), plus a frozen-validator fallback case |
| read | `khala_read` returns history without advancing the cursor |
| send | `khala_send`; attribution and exclude-self (AE3) |
| `you=` | the hook frame has `you="<displayName>"`, which updates after a rename |
| rename event | an owner rename appears as an inbox event (`events/member-rename.ts`) and as the `you=` change |
| rejoin | same session id and `rejoinSecret` give the same member (`agent-join.test.ts:133` pattern); `rejoinable:false` sources give a fresh member |
| steer | a `tool` hook returns context only in steer |
| sync | a `stop` hook returns a continuation once; a second (continuation) stop goes idle |
| async | no frame; activity goes idle |
| idle wake | in sync, an append while idle triggers `wakeProbe.observed` within the deadline; no wake in async or for own messages (AE4) |

Generic tier: the suite runs read, send and status only, and asserts that every hook-dependent row is "unsupported".

## 5. Release-sensitive pieces

1. **Plugin content hash.** `RELEASE_CONTENT` is `hooks/hooks.json`, `skills/khala/SKILL.md`, `.mcp.json`, `bin/khala` (`scripts/sync-release.mjs:23-28`). `claude-plugin.test.ts:12-22` fails unless both plugin versions are bumped and the hash is appended to `src/hooks/fixtures/claude-plugin-releases.json`. `sync-release.mjs:74-78` records it and refuses a hash change under an existing version. `hooks.claude.json` must stay byte-identical to the plugin `hooks.json` (`claude-plugin.test.ts:24-30`, which asserts the exact `hook deliver --harness claude` commands). The refactor should **not** change these four files. Keep `mcp --harness claude`, `hook deliver --harness claude` and `hook claude-wake` as stable CLI argv, and route them through the registry internally.
2. **Stable argv for already-installed hosts.** Codex config points at a stable bin that is updated in place (`install/main.ts:108-112`, `hook deliver --harness codex` :136). Cursor mcp.json pins `khala-cli@<v>` with `--harness cursor` (`install/cursor.ts:62`). The new CLI must keep accepting `hook deliver --harness claude|codex|cursor`, `hook claude-wake`, and `install codex|cursor`.
3. **Frozen compat copies (do not edit):** `control-join-request`, `helper-join-request` and `matrix-message` `*.main.frozen.ts`. Exception, as a deliberate reviewed change: `local-decoder.main.frozen.ts:6` imports live `readHarness`, so widening it silently weakens `wire-compat.test.ts`. Inline the 3-id literal **before** widening. Add new frozen copies of the post-refactor validators so later harness additions are tested against them.
4. **Deploy ordering:** contracts open decoders, then control and web deploy, then the helper wire gate (§2.6), then the CLI release. Rollback after new-id records exist is unsafe (`store.ts:41`, `decodeAgentOwnerRecord`).
5. **`AGENTS.md` version pins.** `sync-release.mjs:20,50-53` rewrites the landing `AGENTS.md`, including the base64 Cursor deeplink. New per-harness install snippets there must use the same rewrite or they will go stale.
