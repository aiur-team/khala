# Native agent surface — summary for the owner

2026-09-18. Answers the direction recorded as [P15](decisions.md): agents install a CLI, native mechanism first, a Khala skill as the fallback, humans get a UI in the same channel.

Every CLI claim below was produced by running the command on the planning host on 2026-09-18. Nothing is asserted from documentation or memory. Full detail and the ticket decomposition are in [the plan](../plans/2026-09-18-kha-145-native-agent-surface-plan.md); the product contract is in [the requirements](../plans/2026-09-18-kha-145-native-agent-surface-requirements.md).

## Recommendation per harness

### Codex — `codex queue`, a shipped CLI send. Priority one.

`codex --version` reports `codex-cli 0.154.0`. `codex --help` lists a top-level subcommand:

```
queue             Queue a message for an existing session
```

and `codex queue --help` gives its signature:

```
Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>
      --thread <THREAD>   Session UUID or exact session name
      --message <TEXT>    Message text to queue
```

This is exactly what P15 asked for and it already exists. `codex agents` — "Browse all agent sessions on the shared local app-server daemon" — confirms sessions are addressable through a shared local daemon rather than only through an executor Khala started itself.

Two things must be proved before it can be claimed (**KHA-146**):

1. **Does it reach a thread a TUI already owns?** `docs/evidence/codex.md` recorded that a thread running in a TUI, `codex exec`, an IDE or another app-server is not attachable and a second writer is refused. `codex queue` going through the shared daemon is plausibly the supported path around that, and if it is, it replaces the Khala-hosted executor for ordinary use.
2. **Can the payload avoid `argv`?** `--message <TEXT>` takes the text as an argument, and `/proc/<pid>/cmdline` is world-readable. If no stdin sentinel works, `codex queue` becomes a *notification* only and the proven app-server route keeps carrying the bytes.

The app-server route stays as the fallback inside the same adapter. `codex app-server --listen`, `--ws-auth`, the daemon subcommands and `~/.codex/thread-writer-locks/` are all present as `docs/evidence/codex.md` described. Worth knowing: with no daemon running, `codex app-server daemon version` fails with `failed to connect to ~/.codex/app-server-control/app-server-control.sock … (os error 2)`, so nothing may assume the daemon is up.

### Claude — no CLI send exists. Two candidate routes, both need a proof.

`claude --version` reports `2.1.276 (Claude Code)`. Its subcommand list is `agents, attach, auth, auto-mode, doctor, gateway, import, install, logs, mcp, plugin, project, respawn, rm, setup-token, stop, ultrareview, update`. **There is no `claude send` or equivalent.** This is the real asymmetry with Codex and it is why Claude gets a proof ticket rather than an implementation ticket.

Two candidates, ranked:

**Route A — the agent's own child process posts to the session inbox.** This is new information that changes KHA-103's conclusion. A child process of a Claude Code session inherits two environment variables; verified by reading the planning session's own environment:

```
CLAUDE_CODE_MESSAGING_SOCKET=/run/user/1000/cc-socks/3194.sock    # srw------- , owner only
CLAUDE_CODE_MESSAGING_TOKEN=<redacted>
```

The 2.1.276 binary mints a `peerToken`/`childToken` pair per session and classifies a presenting token as `"peer"` or `"child"`, and carries a settings key describing inbound delivery:

> `crossSessionInbound`: Inbound cross-session peer messages (SendMessage from your other sessions): 'accept' delivers them, 'hold' parks them for your review without letting Claude act, 'refuse' opts this session out.

So an inbound path into a *running* session exists, it has a policy surface, and a process the agent itself starts is inside the trust boundary rather than outside it. That is precisely the distinction KHA-103 could not exploit, because it was asking whether a stranger could reach in. The wire frame is undocumented, which is why this is a proof and not a plan to build.

There is also a local session registry at `~/.claude/sessions/<pid>.json`, giving discovery, binding and live busy-state in one place. The planning session's own entry:

```json
{ "pid": 3194, "sessionId": "bcca04a8-…", "cwd": "…", "version": "2.1.270",
  "kind": "interactive", "entrypoint": "cli", "peerProtocol": 1,
  "messagingSocketPath": "/run/user/1000/cc-socks/3194.sock",
  "status": "busy", "statusUpdatedAt": 1789765102937 }
```

`claude agents --json` — "Print active sessions (interactive and background) as a JSON array and exit (for scripting; does not require a TTY)" — gives the same discovery without file reads.

**Route B — a Khala-hosted streaming session.** Documented in `claude --help` today, so it is the guaranteed floor: `claude -p --session-id <uuid> --input-format stream-json --output-format stream-json --replay-user-messages --include-hook-events`. `--input-format stream-json` is described as "realtime streaming input" and `--replay-user-messages` as "Re-emit user messages from stdin back on stdout for acknowledgment" — a real acknowledgement, which is what the receipt vocabulary needs. This is the shape the delivery contract already calls `khala_hosted_resume`.

**One correction to the record.** `docs/evidence/claude.md` reported that `--channels` and `--dangerously-load-development-channels` are absent. They are absent *from `claude --help`*, but all three of `dangerously-load-development-channels`, `notifications/claude/channel` and `channelsEnabled` are present as strings in the 2.1.276 binary. The mechanism exists and is hidden. That is a reason to run a proof, not a reason to claim a route.

**MCP is for sending, not receiving.** `claude mcp add` and `codex mcp add` both configure servers loaded at session start, whose tools the model pulls. Good for giving an agent a `khala_send` tool with no shell approval per turn; useless as a way for Khala to push a released message into a running session. Both adapters treat it that way.

### Any other harness — the fallback skill

An installable Khala skill (`SKILL.md` plus a listener) that runs `khala connect`, `khala listen` and `khala send`. It closes the four gaps `docs/evidence/claude.md` recorded against the `Monitor` route — thirty-minute expiry, no reconnect, no backlog, no dedup — by owning the cursor and the reconnect itself.

It is not free: on Claude Code in `default` permission mode, starting a long-running process costs one human approval. The skill says so, and its capability record is `experimental` until a proof upgrades it. P15 asked for a path that works for any model, not a path that costs nothing.

## Human UI gaps

The composer, live timeline, attribution, review selection and approval controls are already built, as injected-port React features under `apps/web/src/features/`. The gaps that remain are these, and most already have owners:

| Gap | Owner | Status |
| --- | --- | --- |
| Browser entry point, bundle, router, live `ChannelPort` | KHA-132 | Not landed. `netlify.toml` publishes `apps/web/dist`, which no build step produces |
| Real `ReviewUiPort` and an owner-authenticated approval route | KHA-134 | Not landed |
| A messaging substrate behind `ChannelSubstrate` | G-SUBSTRATE | Open. No live transport exists, so nothing receives yet |
| **A channel page that puts composer, timeline and review together** | **KHA-152, new** | Nothing composes them today |
| **Agent presence: which agent is connected, on which route, and the install command to hand over** | **KHA-152, new** | No such surface exists anywhere |
| `/api/human/*` and `/api/agent/*` return 503 `feature_unavailable` | KHA-132, KHA-133 | Their producer modules are absent by design until those tickets land |

So the genuinely new UI work is one page and one panel. Everything else is an existing ticket that has not been dispatched.

## Open risks

1. **Both Claude routes may fail.** Route A's frame is undocumented and may be unusable without reverse engineering, which the KHA-103 plan explicitly forbids building on. Route B keeps the session alive but means Khala started it, which is a weaker claim than "your agent, already working". If KHA-145 pins neither, Claude ships `unsupported` again and the fallback skill carries it. The plan is written so that outcome is a legitimate completion rather than a blocked ticket.
2. **`codex queue` may not take stdin.** Then the released bytes cannot travel route A without appearing in a world-readable process argument, and route A is demoted to a notification. This is a design fork inside KHA-150, not a blocker.
3. **Hidden and undocumented surfaces move.** `crossSessionInbound`, the messaging socket and the session registry are not in either CLI's public help. A minor version bump can remove them without a deprecation. Every capability record is pinned to an exact version and no semver promotion is allowed, which contains the blast radius but does not prevent it.
4. **G-SUBSTRATE gates the proof of the whole loop.** Without a transport, KHA-153 can only demonstrate against fakes. The native surface can be complete and still unprovable end to end.
5. **The airlock is only as strong as the connector host.** Every route delivers released bytes to a process on the same machine as the agent. P04 already disclaims resistance to an agent with unrestricted access to the connector host; nothing here changes that, and the presence panel must not imply otherwise.
6. **Cloud and desktop are unplanned.** `codex remote-control pair` and `claude --cloud` exist and are out of scope per P15. If the owner later wants an agent in a cloud session to join a channel, that is new work, not a configuration of this one.

## What changes in the tracker

| Ticket | Effect |
| --- | --- |
| KHA-103 | Amended. Its "no supported route" conclusion is scoped to third-party attachment; KHA-145 asks the agent-installed question instead |
| KHA-117 (issue #26) | Amended by KHA-149. The fail-closed adapter keeps its checks; only the final refusal is replaced, and only if KHA-145 pins a route |
| KHA-118 | Amended by KHA-150. `codex queue` is added as route A; the proven app-server route stays as route B |
| KHA-133 (issue #42) | Amended by KHA-153. Adapter selection moves from a single fail-closed adapter to a capability-driven choice, and the runtime must expose agent presence to the channel page. Issue #42's bootstrap-restart trap and terminal-revocation rule are carried into KHA-153's test scenarios |
| KHA-106 | Amended by KHA-147, the only ticket permitted to write `packages/contracts/src/delivery/` |
