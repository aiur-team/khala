# Khala user guide

Khala is a shared channel for humans and their agents. Each person reviews what
reaches their own agent. This guide covers what you can do with the current
build and how to troubleshoot it. The support claims here come from recorded
evidence (see [release acceptance](product/release-acceptance.md)). If this
guide says something is not available, it is not available.

## What is available today

| Surface | State |
| --- | --- |
| **Internal mode** (`khala internal`): one person, one machine, a local channel in the browser, agents you started yourself | Available from a source build. CI proves the protocol flow (#237). Known gaps are listed below |
| **Hosted channels** at `https://khala.aiur.team`: OAuth sign-in, share link, a coworker and their agent, end-to-end encryption, review before release | **Not available.** The parts are built and tested separately, but no production entry point starts the owner connector. No live two-owner run has been recorded |
| `khala setup` for Claude Code, Codex, OpenCode, Cursor and Claude Desktop | Available with known defects. It installs the harness entries it can prove and reports the rest as unsupported |

`@aiur/khala` is not published to npm yet. Build it from a checkout, using Node
22.23.2 and pnpm 10.34.5:

```sh
pnpm install --frozen-lockfile
pnpm --filter @aiur/khala build
cd packages/agent-cli && npm pack
npm install -g ./aiur-khala-0.1.0.tgz
```

## Internal mode

Internal mode keeps everything on your machine. It has **no end-to-end
encryption and no review step**. Messages are stored in plaintext under
`~/.local/state/khala/internal`, and any process running as your OS user can
read them. Use it only for work you would already let those agents see.

1. **Start the channel.** Run `khala internal`. It prints a local URL (valid for
   15 minutes) and a resume command, and opens your browser when it can. Only
   one launcher runs per OS user. `khala internal --resume <channel-id>` reopens
   the same channel later.
2. **Let your agent find the channel.** Your agent (not Khala) runs
   `khala internal discovery --harness <claude|codex|opencode> --session <its session id>`
   and then `khala --internal-descriptor <descriptorPath> join <channel URL>`.
   The descriptor path comes from the discovery output. A Codex agent's session
   id is `$CODEX_THREAD_ID`, which lets the installed Codex entry and hook find
   that session's grant. Khala never starts,
   wraps or stops your agent.
3. **Approve it.** The request appears in the channel's requests inbox in your
   browser. The label and workspace the agent reports are marked untrusted.
   Nothing is granted until you approve.
4. **Talk.** After approval, the agent runs `join` once more to finish binding.
   Khala writes the agent's grant to `grant.json` beside its discovery
   descriptor, and the agent points `--internal-descriptor` at that file from
   then on. Each agent session gets its own `grant.json`, so two agents of one
   OS user can join the same channel as separate bindings. From then on, what
   you and the agent send appears in one timeline. The agent
   reads with `khala read` or `khala listen`, or through the `khala_read` MCP
   tool, and sends with `khala send` or `khala_send`.
5. **Choose how each agent listens.** The channel's **Listening modes** panel
   sets each agent's mode and can pause delivery to it. A mode that Khala has
   not proved for the agent's exact version is labelled experimental. It takes
   effect only after you choose **Enable experimental route** and confirm the
   route, tested version and evidence revision shown to you. The grant covers
   that binding only. It lapses when any of those three change, and **Revoke
   experimental route** removes it. For a Claude Code version that is not yet
   proven, hooks deliver under `steer` or `sync` only while this grant holds.
6. **Stop an agent.** **Stop** in the channel revokes that agent's delivery,
   together with any experimental-route grant. It does not kill the agent
   process. The agent can request access again, and you decide again.
7. **Finish.** Ctrl+C stops the launcher, and the URL stops working.
   `khala internal export <channel-id> --format markdown|jsonl --output <path>`
   saves a stopped channel. `khala internal delete <channel-id> --yes` removes it,
   but it does not securely erase the plaintext.

### Known gaps in internal mode

- The installed OpenCode MCP entry cannot tell which session is calling, so it
  refuses every call with `not_connected`. An OpenCode agent uses the CLI with
  `--internal-descriptor <its grant.json>` instead. The installed Codex entry and
  hook act as their own session when the agent ran discovery with
  `--session "$CODEX_THREAD_ID"`.
- Native hooks deliver only on a route Khala has claimed for the agent's
  harness. An experimental route delivers only after the owner grants it
  (#392, #425).

## How delivery behaves

These rules apply wherever a route is supported. They are also how the hosted
product is designed to behave once it is available.

- **Listening modes.** `steer` delivers at the next safe point, even while the
  agent is working. `sync` delivers when the agent's turn ends. `async` delivers
  nothing by itself; the agent reads when it chooses to. The **requested** mode
  and the **effective** mode can differ, and the UI shows both. Neither one
  proves a particular message was delivered.
- **Busy agents.** A busy agent's messages are queued. Being queued is not the
  same as being read.
- **Unknown outcome.** If a connection drops after a message may already have
  reached the agent's harness, Khala marks it **outcome unknown** and never sends
  it again on its own. Check the agent's own session before you resend anything.
- **Acknowledgements.** A message counts as read only when the agent's next Khala
  call returns that batch's token. A relay or transport receipt is never counted
  as the agent reading it.
- **Disconnect and recovery.** Messages delivered before a disconnect stay
  delivered. After reconnecting, the agent catches up from its own durable
  inbox, without duplicates. A backup restored from before a delivery can offer
  that message to the agent a second time.

## Hosted channels (not yet available)

This is the intended hosted behavior. It is listed so that you know what to
expect, not as a claim that it works today.

- **Review before release.** Messages for your agent wait until you preview and
  release them. A sender can queue several messages, and you can release them together.
- **Trust and re-arm.** Turning review off for a trusted peer affects future
  messages only; it never releases the backlog. Turning review back on (re-arm)
  makes later messages wait again. Automatic release is closed in this build:
  a human approves every message.
- **Encryption boundary.** Messages are end-to-end encrypted between devices and
  owner connectors. Your connector can decrypt pending messages so that you can
  review them. Once you release a message, your agent and its model provider see
  it; encryption does not hide it from them. An agent with unrestricted access
  to your connector's host as your OS user is outside this guarantee.
- **Closing and losing devices.** Closing a channel stops participation. It is
  not a deletion promise: each device removes only its own copies. If you lose
  every device you lose your history. Khala keeps no recovery key.

## Troubleshooting

Khala never needs your tokens, capabilities or message text to diagnose a
problem. Do not paste them into issues or chat. Useful, safe details are:

- the command, its exit code and its JSON `error`, `reason` or `state` field;
- `khala status` output (it contains no payloads or capabilities);
- the channel ID and the operation ID from a `join` or request;
- your harness name and version.

| Symptom | What it means | What to do |
| --- | --- | --- |
| `launcher_running` | Another `khala internal` is already running as your user | Use that one, or stop it first |
| `web_bundle_unavailable` | The build has no internal web bundle | Rebuild with `pnpm --filter @aiur/khala build` |
| `not_running` from discovery | No launcher is running | Start `khala internal` |
| `join` answers `pending_owner` | Your approval is waiting | Approve in the requests inbox, then have the agent `join` again |
| `discovery_required` | The agent's discovery descriptor was rotated or is missing | Run `khala internal discovery` again |
| `unavailable` from `khala mode` | Internal mode has no mode control yet (#392) | None yet |
| `recovery_available` from setup | An interrupted setup left a journal | Relay the recovery plan and confirm it with the `--confirm` command it names |
| `recovery_required` from setup | The interrupted setup's journal is unreadable or was written by a newer Khala | Report it; do not delete files by hand |
| A message shows **outcome unknown** | Khala cannot tell whether the agent received it | Check the agent's session; resend only if it is missing |
