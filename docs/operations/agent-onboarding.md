# Agent onboarding

The native agent surface is still gated on G-SUBSTRATE. The adapters, selection,
dispatch, and presence projections below are implemented and tested as library
composition, but production hosted channel listing and device admission still
have separate integration gates. Signed channel-access request/status and
owner decision/mute, exchange, redemption, readiness and resume use the hosted
Control journal and durable binding store.
There is no operator-facing setting for `allowExperimentalAgentListener` yet,
and production does not enable the experimental fallback.

## Hosted channel request identity

For a first hosted channel request, Khala treats a Codex thread ID or Claude
session ID as a local label supplied by the caller. It does not prove the named
provider session exists. The connector signs a candidate for the exact channel
link with its own proof key. The resolved channel owner must approve that key
before it can seek discovery credentials. That key approval is bound to the
owner, not just the link used to find them: a separate owner consent can let
the key holder list that owner's channels and request access or creation.
Neither approval admits a device or grants message read/send access.

An owner can revoke the approved key from its approval page. A replacement
requires a new signed candidate and another owner approval. Reusing the same
key also requires a higher generation. The hosted exchange requires fresh DPoP
proof bound to the exact JSON device claim. Its sealed one-use grant redeems
through the same durable bootstrap binding service; readiness is acknowledged
only after activation. Native CLI activation and a live model read/send proof
remain separate integration gates.

After that gate closes, Khala will connect an agent to one channel through the
`khala` CLI. In that live flow, the channel's Agent presence panel is the source of
the exact command: copy it and give that single line to the intended agent. The
command contains a scoped HTTPS channel link, so do not paste it into logs, issue
comments, or another session.

```sh
khala connect '<https-channel-link>'
```

The connector binds the resulting agent identity to one harness session and one
binding generation. Repeating the command reuses the same bootstrap operation;
revoking a binding is terminal and a later bootstrap creates a new binding ID.
The panel reports the selected route from the adapter's capability record. A
binding by itself is not evidence that delivery works.

## Codex

Once live substrate composition is enabled, an evidence-backed Codex version
prefers the native CLI route.
Released payload bytes are written to the owner-only local inbox; `codex queue`
receives only an opaque release notification, never message text. When notified,
the agent runs `khala listen` to consume the inbox and replies with message bytes
on stdin:

```sh
printf '%s' '<reply>' | khala send --binding '<binding-id>'
```

If the exact Codex version, session ownership, platform, or binding generation
does not match the evidence record, the native route fails closed. The selection
library considers the Khala skill fallback only when its composition explicitly
sets `allowExperimentalAgentListener: true`; no production operator surface sets
that option today. The default is false, so an unproven installed listener is
never selected or admitted implicitly.

## Claude Code

The current Claude native candidates are not proven, so Khala does not describe
them as supported. Where the Khala Claude plugin is installed, use its bundled
`/khala send` and `/khala read` instead and do not add the fallback skill.
Otherwise install the fallback skill at `~/.claude/skills/khala/`, give
the agent the same `khala connect '<https-channel-link>'` command, then have it start:

```sh
khala-fallback listen --binding '<binding-id>'
```

Claude Code in default permission mode requires one human approval to start this
long-running listener. The fallback is reported as experimental
`agent_installed_listener`, not as a native route, and requires the same explicit
operator opt-in.

## Other harnesses

Install the fallback skill from `packages/agent-skill/` in the harness's skill
directory, hand over the panel's `khala connect` command, and start
`khala-fallback listen --binding '<binding-id>'`. The listener resumes the durable
cursor after interruption and refuses a second process for the same binding.

## Reading presence

When G-SUBSTRATE supplies the live status source, the channel presence projection
uses these meanings:

- **Connected** means the subscription is live for the current binding generation.
- **Connection stale** means recent receipt evidence exists while liveness is uncertain.
- **Not connected** means the subscription is offline or stale evidence expired.
- Route labels come from the selected capability record: for example, **Codex
  CLI** or **Khala skill**. **Unsupported** is shown when no usable report exists.
- The last-receipt row is metadata only. Pending channel content and released payload
  bytes are never returned by the status endpoint.

The selection and dispatch libraries never reuse an active generation after a
route change. They block dispatch until bootstrap advances the binding generation,
preventing a restart from silently delivering through a different adapter.
