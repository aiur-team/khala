---
title: "fix: Keep channel text out of every harness's Stop continuation"
date: 2026-10-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
depth: lightweight
---

# fix: Keep channel text out of every harness's Stop continuation

## Summary
Sibling of #1295 (Cursor). Several harnesses turn a Stop hook's `reason` into a new user prompt. Khala put the raw channel frame there, so untrusted channel content arrived as if the user had typed it. Every Stop continuation now carries one constant, content-free nudge. The agent reads the content with `khala_read`, which returns recent history whatever the delivery cursor says.

## Problem Frame
- Codex: `{decision:'block', reason}` "creates a new continuation prompt that acts as a new user prompt". Codex's Stop has no `additionalContext`. (Codex hooks docs.)
- Qwen spreads `claudeStyleCodec`, so it has the same defect.
- Copilot `agentStop` block reason, Gemini `AfterAgent` deny reason and Antigravity Stop `continue` reason each re-prompt the model with `reason`.
- Unchanged: Claude already uses Stop `additionalContext`, which is not a user turn. In OpenCode's idle wake, the visible prompt is the constant wake line and the frame travels only as a synthetic part (OpenCode's context channel). Wake drivers already send the constant `wakeLine(nonce)`. Prompt and tool hooks inject content as additional context.

## Requirements
- R1. No harness's Stop output carries channel text in a field the harness submits as a user turn.
- R2. The nudge is one shared constant: `Khala: channel messages are waiting. Call khala_read.`
- R3. Cursor-advance and wake semantics are unchanged: a nudge is emitted exactly when a frame would have been.
- R4. The goldens, codec tests, deliver tests and conformance drivers reflect the nudge.

## Key Technical Decisions
- Hoist `CURSOR_STOP_NUDGE` to an exported `STOP_NUDGE` in `packages/agent/src/harness/adapter.ts`. Each codec's `render('stop', …)` ignores the frame and emits the nudge. This is the same pattern as #1295, and it keeps the fix in the dialect layer instead of `deliverCore`.
- `claudeCodec` keeps the frame in Stop `additionalContext`, so only `claudeStyleCodec` changes. That covers Codex and Qwen.
- The wake-disable notice that was appended to the frame is dropped on these Stop paths, as it already is for Cursor. The notice still shows in `khala_status`.

## Implementation Units

### U1. Shared nudge in the Stop codecs
**Files:** `packages/agent/src/harness/adapter.ts`, `packages/agent/src/harness/codecs/{cursor,claude-style,copilot,gemini,antigravity}.ts` and their `*.test.ts`
**Approach:** Export `STOP_NUDGE`. Cursor re-exports or uses it. The other four codecs put it in their Stop `reason`.
**Test scenarios:** For each codec, `render('stop', 'frame')` contains the nudge and does not contain `frame`. The `claudeCodec` Stop output still contains the frame as `additionalContext`.

### U2. Goldens, deliver tests, conformance
**Files:** `packages/agent/src/harness/__golden__/deliver-codex-Stop-*.json` and any other Stop goldens the tests regenerate; `packages/agent/src/hooks/deliver.test.ts`; `packages/agent/src/harness/conformance/drivers/{codex,qwen,copilot,gemini,antigravity}.ts`
**Approach:** Set `syncNudge: STOP_NUDGE` on the affected drivers so the runner asserts the constant line. Regenerate goldens with the repo's update flag and review each diff: only Stop `reason` values may change.
**Test scenarios:** A Codex Sync Stop with an unread hostile message prints the nudge and advances the cursor. The conformance sync case passes for each driver.

### U3. Docs
**Files:** `docs/settings.md`, `packages/agent/docs/install-*.md`, `apps/web/src/landing/public/AGENTS.md`, `packages/agent/claude-plugin/khala/skills/khala/SKILL.md` (only where they say Stop delivers content)
**Test expectation:** `apps/web/src/landing/agent-instructions.test.ts` stays green.

## Verification Contract
Run targeted vitest on the codec tests, `harness/characterization.test.ts`, `hooks/deliver.test.ts`, the conformance tests and `agent-instructions.test.ts`, plus `tsc` for `packages/agent`.

## Definition of Done
R1–R4 hold. The PR states that the goldens changed and why.
