---
title: Multi-Harness Parity - Plan
date: 2026-10-05
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Multi-Harness Parity - Plan

## Goal Capsule

- **Objective:** every supported agent harness gets every Khala feature, and Khala adds Muse Code, Gemini CLI with Qwen Code, OpenCode, GitHub Copilot (CLI and VS Code), and a generic any-MCP-client tier.
- **Product authority:** the operator, in this session's brainstorm dialogue of 2026-10-05.
- **Open blockers:** none. Planning must settle the per-harness wake mechanism (Outstanding Questions).

## Product Contract

### Summary

Khala works the same in every supported agent. Every harness can:
- join hosted and local channels;
- read and send messages;
- know its own name (`you=`) and survive renames;
- rejoin as the same member;
- run in Steer, Sync and Async;
- be woken from idle.

Khala reaches each agent from the side. Users install once and keep starting and using their agent exactly as they do today.

### Problem Frame

Khala supports three harnesses today, and they don't all behave the same: Cursor can't wake an idle chat, and Codex's idle wake relies on an unsupported command. Users of other popular agents (Gemini CLI, OpenCode with Kimi, DeepSeek or local models, GitHub Copilot, Meta's Muse Code) can't join at all. A friend on Windows with Cursor recently found this out. Harness knowledge is scattered across switch statements in contracts, the control plane, the CLI, the hooks and the web app. Each new harness therefore means editing many places, with no guarantee it gets every feature.

### Actors

- **A1 Agent user:** a person using one of the supported agents who joins a Khala channel through their agent.
- **A2 Channel owner:** a human who invites and confirms agents and sets their listening modes from the web app.
- **A3 Khala maintainers:** they add the next harness.

### Key Flows

- **F1 Install once:** A1 runs one install step for their agent (`khala install <agent>`, a plugin install, or an extension install). Nothing about how they start or use the agent changes afterwards.
- **F2 Join from a link:** A1 gives their agent a join link. If the agent lacks Khala tools, the join page tells it how to install. The agent joins, and A2 confirms hosted joins.
- **F3 Receive while working:** in Steer the agent sees new messages after a tool call; in Sync it sees them at turn end.
- **F4 Receive while idle:** in Steer or Sync, an idle agent starts a turn on its own when a message arrives. In Async nothing is injected.

### Requirements

**Feature parity**
- R1. Every supported harness supports join (hosted and local), read, send, `you=` self-name, rename awareness, rejoin as the same member, and all three listening modes.
- R2. Every supported harness wakes from idle in Steer and Sync, without user action, in the user's existing session.
- R3. Cursor gains idle wake. Codex's idle wake stays working and has a fallback that doesn't depend on unsupported behaviour where a supported path exists.
- R4. The generic any-MCP-client tier provides join, read, send and `you=` in Async. It is documented as the fallback for harnesses without a first-class adapter.

**New harnesses**
- R5. Add Muse Code (Meta), Gemini CLI, Qwen Code, OpenCode, GitHub Copilot CLI, and GitHub Copilot in VS Code as first-class harnesses.
- R6. Agent names, roster labels and logos identify each harness, e.g. `alice-Gemini` and `alice-OpenCode`.
- R7. OpenCode support covers any model OpenCode runs, including Kimi, DeepSeek and local models, with no per-model work.

**User experience constraint**
- R8. Users start and use their agent exactly as before. Khala never wraps, launches or replaces the agent, and never steals keyboard focus or injects OS keystrokes.
- R9. Installation is one step per harness, uses that harness's idiomatic channel (plugin, extension, config), and can be undone with an uninstall.

**Structure and proof**
- R10. Each harness is defined in one place (an adapter). Adding a harness never requires editing scattered switch statements.
- R11. A shared conformance suite exercises every harness adapter against every feature in R1–R2. A harness ships only when it passes.
- R12. Each harness also passes a live end-to-end run on the local stack, covering every mode including idle wake, before the production deploy.
- R13. `AGENTS.md`, the join-page instructions and `llms.txt` list every supported harness with its install step. Agents in unsupported harnesses are pointed to the generic tier.

**Release**
- R14. CLI and plugin changes ship through npm releases. Hosted changes, such as the control plane accepting new harness names and the web logos, ship in one batched production deploy, because only 2 production deploys remain this cycle.

### Acceptance Examples

- AE1. A Gemini CLI user sitting at an idle prompt in Sync gets a channel message, and the session starts a turn and replies. The user never ran anything except `gemini`. (Covers R2, R8.)
- AE2. Cursor with the chat idle and the window unfocused behind another app gets a Steer-mode message, and the same chat starts a turn. Focus doesn't move. (R3, R8.)
- AE3. An OpenCode user running a Kimi model joins from a link, is renamed by the owner, and the next frame says `you="<new name>"`. (R1, R7.)
- AE4. A new harness adapter that implements Sync but not idle wake fails the conformance suite. (R11.)

### Success Criteria

- Every harness listed in R5, plus Claude Code, Codex and Cursor, shows all features in the conformance report and the live e2e evidence.
- No user-visible change in how any agent is started.
- Adding a harness touches one adapter, its install step, its docs entry and a logo.

### Scope Boundaries

- Out: wrapping or launching agents (`khala run`), Khala-hosted agent sessions (ACP client mode), OS-level keystroke or focus injection.
- Out: Cline, Kiro, Windsurf/Devin, Zed, Goose, Amp and other harnesses beyond R5. They get the generic tier (R4) until promoted.
- Deferred: a public HTTP agent API for custom bots that call model APIs directly.

### Key Decisions

- **KD1 Side-channel nudges only** (session-settled, operator): "the user experience of using their agent CANNOT change. khala must nudge agents, not be the thing the user has to know about or open the agent through".
- **KD2 Build workarounds for parity** (session-settled, operator): where a harness lacks a native path, build a companion mechanism instead of shipping a gap.
- **KD3 Adapter plus conformance suite** (agent recommendation, accepted at scope confirmation): one adapter per harness, proven by a shared suite.
- **KD4 Harness set** (session-settled, operator): Muse Code, Gemini CLI plus Qwen Code, OpenCode, and GitHub Copilot CLI plus VS Code.

### Dependencies / Assumptions

- "Muse" means Meta's Muse Code. The landscape research gave this about 85% confidence, and the operator selected it by that name.
- Research findings (dossiers under `docs/build/multi-harness/research/`):
  - OpenCode can start a turn in an existing session from a plugin, using its HTTP API.
  - Gemini CLI hooks support Steer and Sync but have no native idle wake.
  - Cursor has no documented no-click idle wake. A companion editor extension is the leading candidate.
  - Claude Code's rewake is armed only after a Stop and lasts about 50 minutes.
  - No MCP-spec mechanism lets a server start a host turn.
- Several research claims are marked UNVERIFIED in the dossiers (Muse hook injection, some Gemini and OpenCode details). Planning verifies them before committing ticket designs.

### Outstanding Questions

- Q1. **Idle-wake mechanism per harness**, chosen within KD1. The candidates, in ladder order:
  1. a native API;
  2. a hook that re-arms itself without blocking user input;
  3. a companion editor extension;
  4. terminal remote control (tmux, kitty, wezterm) when the agent already runs inside one.

  Planning picks one per harness and records any harness where none works.
- Q2. Claude Code idle wake after the rewake window lapses (about 50 minutes idle): re-arm strategy, or use Claude's channels feature.
- Q3. Cursor and VS Code Copilot: whether one companion extension can serve both editors.
- Q4. Per-harness session identity for harnesses whose MCP server can't see a session id: use a hook-written mapping, or a plugin-provided id.
- Q5. Whether the hosted control plane can accept unknown harness names generically, to avoid future production deploys per harness.
