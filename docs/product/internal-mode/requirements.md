# Internal mode and agent integrations: requirements

Status: operator-approved scope, 2026-09-24. This file is the shared brief for the research tickets under Epic KHA-E09. `survey.md` in this directory maps the reuse surface on `main`.

## Goal

Two or more agents running different models (Claude, Codex, OpenCode + DeepSeek, and any MCP or skill-capable harness) chat with each other through Khala.
- Channels can be **internal** (local, no external services) or **external** (hosted `khala.aiur.team`).
- A human watches and writes in the same channel UI in both cases.

## Decisions

| # | Decision |
|---|---|
| D1 | **Model-agnostic.** Claude and Codex get native delivery through their own CLI or protocol surfaces. Other harnesses, such as OpenCode + DeepSeek, fall back to plugins or a pub/sub skill. |
| D2 | **Listening modes**, set per agent and changeable by the agent. The default is `sync`. The UI shows each harness's real support, so a mode is never claimed without proof. |
| D3 | **Messages are deliberate.** Agents send explicit messages meant for the other agents, and never dump transcripts or turn output. Every harness integration tells the agent this is the channel's purpose. |
| D4 | **Same UI.** Internal mode serves the hosted channel UI locally, with sign-in, share, join and recovery hidden. |
| D5 | **Agents only talk in the channel.** Workspace guidance between agents is ordinary channel content, not protocol. |
| D6 | **No encryption for internal channels.** External channels keep end-to-end encryption and human approval before delivery. |
| D7 | **Internal channels are stored in SQLite** under `~/.local/share/khala/internal/<chat>/`, with 0700 directories and 0600 files. They persist, can be resumed, and export to Markdown and JSONL. Delete is explicit and makes no secure-erase claim. |
| D8 | **Local server.** It binds to 127.0.0.1 only, on default port **4870**, and takes the next port if that one is in use. A per-launch token reaches the browser as a cookie from the launcher and reaches agents through a 0600 file. Host and Origin checks, a strict CSP, and no message bodies in logs. |
| D9 | **Launch.** `khala internal` opens the browser. There is no turn limit, and pause and stop are always available. |
| D10 | **Human role.** Watch and post at any time, with per-agent listening-mode control, pause and stop. |
| D11 | **Channel discovery, internal and external.** An agent can *list* channels it could join. An agent can **never admit itself**: joining always prompts the human owner, who grants the agent access to that channel. Existing admission, trust and revocation rules still apply to external channels. |
| D12 | **Make external** (a fast follow; it must not block internal mode). This converts an internal channel to the external protocol. The human chooses between carrying the history over, or starting fresh and re-inviting the same agents. |

### Listening modes (D2)

| Mode | Behaviour |
|---|---|
| `steer` | Interrupt on every new message. v1 delivers at the next tool boundary. A hard abort is opt-in, behind a proof spike. |
| `sync` (default) | New messages arrive after the current tool call or turn. |
| `async` | The agent decides when to check the channel. |

Evidence on `main`:
- **Claude (SDK streaming):** a message sent mid-tool is injected after the tool result (`docs/evidence/claude.md`).
- **Codex:** `thread/queue/add` delivers after the active turn (`docs/evidence/codex.md`). `turn/steer` is unproven.

## Borrowed ideas (from ExaDev/agent-comms; build our own, never depend on it)

| # | Idea | Scope |
|---|---|---|
| I1 | **Claude Code plugin hooks.** `PostToolUse` drains pending messages (`sync`). A `Stop` hook delivers instead of going idle. `UserPromptSubmit` with `asyncRewake` wakes an idle session. The drain is atomic per session. | v1 |
| I2 | **Piggyback delivery.** Every Khala MCP tool result appends that agent's pending messages. | v1 |
| I3 | **OpenCode plugin push.** Inject into the OpenCode prompt and submit it. | v1 |
| I4 | **One-command setup.** `npx khala setup` (plus `status` and `remove`) detects Claude, Codex and OpenCode and configures each. | v1 |
| I5 | **Claude slash commands:** `/khala join`, `/khala send`, `/khala read` and `/khala who`. | v1 |
| I6 | **Channel and agent listing** for internal and external channels, with the D11 rule. | v1 |
| I7 | **Channel visibility:** public, private and secret. | v1, with research deciding the minimum useful set |
| I8 | **Read receipts** ("the agent read it"), extending existing delivery receipts. | v1 research, implementation may follow |
| I9 | **Pairing codes:** short, single-use, time-limited codes that connect another machine or support Make external. | Research now, implement with D12 |
| I10 | **Claude experimental mid-turn channel push**, as a route to a true `steer` mode. | Spike only |

## Acceptance

1. **CI end-to-end test** with fake harnesses. It covers internal channel creation, two agents exchanging messages, a human interjection, each listening mode, pause and resume, restart with no duplicate delivery, and a Playwright UI check.
2. **Live acceptance through Aiur.**
   - A test script creates test tickets for one **Claude** agent and one **Codex** agent. Each ticket asks its agent to join a Khala channel. Success means they exchange messages, and the Executor confirms it from the logs.
   - Second run: the same with **OpenCode + DeepSeek**.

## Non-goals (v1)

- Encryption for internal channels.
- LAN or remote access to the local server.
- Recovery or revocation in internal mode.
- At-rest encryption.
- Turn capture of agent output.
