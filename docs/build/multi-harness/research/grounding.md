# Grounding: multi-harness parity (origin/main, extraction by scout, saved by Executor)

## Harness enum + switches
- packages/contracts/src/m1/agent-join.ts:4,46  Harness = 'claude'|'codex'|'cursor'; HARNESSES tuple
- packages/contracts/src/m1/names.ts:16,29  agentSuffix regex; MODEL_NAMES {claude:'Claude',codex:'Codex',cursor:'Cursor'}
- apps/control/src/agent-join/agent-routes.ts:48, store.ts:41  control validates HARNESSES
- packages/agent/src/local/routes/agent-join.ts:44, join.ts:59, state.ts:49-50  agent-side validation; state dir per harness
- packages/agent/src/compat/helper-join-request.main.frozen.ts:9  frozen copy (claude,codex,cursor)
- packages/agent/src/mcp/session-id.ts:4-24  resolveHarness (--harness / KHALA_MCP_HARNESS / CLAUDE_CODE_SESSION_ID); session id: claude=CLAUDE_CODE_SESSION_ID, cursor=workspace hash, codex=_meta.threadId|CODEX_THREAD_ID
- packages/agent/hooks/deliver.ts:85,89  harness check; cursor → deliverCursor
- packages/agent/src/mcp/wiring.ts:12-13  waker only for codex (createCodexWaker)
- packages/agent/src/client-impl.ts:51  cursor-default not rejoinable
- web duplicates: roster-model.ts:52, attribution.ts:64, AgentConfirm.tsx:15 HARNESS_NAMES; ui/khala/identity.ts:105-110 harnessLogo (cursor → null); MentionChips.tsx:22; fake-local-helper.ts:42
- listening modes: contracts delivery/listening-mode.ts:6 ['steer','sync','async']; default 'sync' (m1/listening-mode.ts:8)

## Install flows
- packages/agent/src/install/main.ts:95-127  `install codex` (pinned copy under ~/.local/share/khala/npm, [mcp_servers.khala], 3 hooks); `install cursor` → runCursorInstall
- packages/agent/src/install/cursor.ts:11-12,62  hooks beforeSubmitPrompt/postToolUse/stop; mcp.json npx entry with KHALA_CURSOR_WORKSPACE=${workspaceFolder}
- Claude plugin: claude-plugin/khala/.mcp.json (launcher bin/khala mcp --harness claude); hooks.json SessionStart --ensure-installed; PostToolUse/UserPromptSubmit/Stop → hook deliver; Stop also hook claude-wake (asyncRewake, timeout 3300)
- hooks.codex.json: PostToolUse, UserPromptSubmit, Stop → hook deliver --harness codex

## Delivery (packages/agent/hooks/deliver.ts)
- :33-38 renderFrame `<khala-channel-messages channel you count>` + INTRO; max 50 entries, 64 KiB
- :104 PostToolUse only in steer; :105 UserPromptSubmit → activity busy; Stop with stop_hook_active → idle
- :122-124 claude/codex envelope: Stop → {decision:'block', reason}; else hookSpecificOutput.additionalContext
- :150-197 cursor: stop → followup_message (sync, ≤1/turn); postToolUse → additional_context (steer); beforeSubmitPrompt only records activity; "Cursor cannot start an idle agent"

## Wakers
- wake/idle-wake.ts:8,26  Codex: `codex queue --thread <id> --message 'Khala: channel messages are waiting. Continue.'`
- wake/codex.ts:45-60  skip async; only when idle; ≤2 wakes per cursor; retry 60s
- hooks/claude-wake.ts:7-80  Claude: watcher armed at Stop, polls 500ms, exit 2 = asyncRewake; deadline 3000s; skip async
- Cursor: no waker

## Docs
- docs/settings.md:18-36 modes; "Idle agents wake (Claude Code and Codex; Cursor agents do not wake)"
- packages/agent/docs/install-cursor.md:43-57 limits (no idle wake; one identity per window)
- apps/web/src/landing/public/AGENTS.md:7 supported harnesses Claude Code, Codex CLI, Cursor
