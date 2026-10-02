# Aiur channel events

## What this is

This guide connects Aiur event records to compact Khala channel progress pills using the [channel events plan](../plans/2026-10-01-003-feat-channel-events-plan.md). M1 supports agent forwarding through `khala_event`; a process-level adapter needs a future emitter decision.

## Event shape

[C9](../build/m1/contracts.md#c9-channel-event-events-lane) defines the encrypted Matrix type `com.khala.event.v1` and its [contract](../../packages/contracts/src/m1/channel-event.ts). The plan's schema table is reproduced below; the tool fills `v` and `body` when encoding event input.

| Field | Type | Req | Rule / meaning | Aiur origin |
|---|---|---|---|---|
| `v` | `1` | yes | Contract version | — |
| `kind` | string | yes | `^[a-z0-9_-]+(\.[a-z0-9_-]+)*$`, at most 128 bytes, lowercase | topic class (`ticket.<n>.` stripped) |
| `summary` | string | yes | 1–200 chars, single line, plain text | derived by the mapper; alert/agent `message` |
| `status` | enum | no | `info` \| `pending` \| `success` \| `failure` \| `attention`. Default comes from the kind table, else `info` | `ci_conclusion`, `needs_attention`, PR action |
| `subject.ticket` | string | no | at most 64 chars, a display label such as `AIUR-395` | topic segment / `ticket` / `source_ticket_id` |
| `subject.pr` | integer > 0 | no | PR number | `pr.number` / `pr_number` |
| `subject.branch` | string | no | at most 255 chars, without `refs/heads/` | `pr.head.ref` / `ref` |
| `subject.repo` | string | no | `owner/name` | `repo` / `pr.base.repo.full_name` |
| `subject.sha` | string | no | 7–64 hex chars, lowercased | `pr.head.sha` / `head_sha` / `sha` |
| `actor` | string | no | at most 64 chars, display hint only | `actor`, `comment.user.login`, `pr.user.login` |
| `url` | string | no | `https:` only, at most 2048 chars | `pr.html_url`, `comment.html_url` |
| `occurred_at` | RFC 3339 | no | display only, never used for ordering | `timestamp`, `occurred_at`, `first_seen_at` |
| `source` | object | no | `{system: string ≤32, topic?: string ≤256, event_id?: string ≤64}`, provenance | `"aiur"`, `topic`, `id` / `event_id` |
| `key` | string | no | at most 200 chars, the dedup key (KTD5) | Aiur dedup keys / `id` |
| `body` | string | yes | equals `formatChannelEventLine(content)`, a fallback text for logs and other clients | — |

The whole content must be 4 KiB or less. Unknown fields are ignored. Unknown `kind` values are accepted.

## Field mapping

Use [mapAiurEvent and AiurMapOptions](../../packages/contracts/src/m1/from-aiur.ts) rather than implementing translation in Aiur. All fixtures below live in [`packages/contracts/fixtures/aiur-events/`](../../packages/contracts/fixtures/aiur-events/); [KM-171 tests](../../packages/contracts/src/m1/from-aiur.test.ts) assert their complete outputs.

| Aiur topic class / record | Khala `kind` | `status` | `summary` | Subject / extras | KM-171 fixture |
|---|---|---|---|---|---|
| `branch.push` | same | info | `pushed <sha7>` | branch from `ref`, sha, repo | `branch-push.json` |
| `pr.opened` | same | info | `[draft ]PR #<n> opened` | PR, branch, sha, repo, actor, URL | `pr-opened-draft.json` |
| `pr.ready_for_review` | same | pending | `review requested` | PR, branch, sha, repo, actor, URL | `pr-ready-for-review.json` |
| `pr.merged` | same | success | `PR #<n> merged` | PR, branch, sha, repo, actor, URL | `pr-merged.json` |
| `pr.review_comment` | same | failure for `CHANGES_REQUESTED`, success for `APPROVED`, else info | `changes requested by <login>`, `approved by <login>`, or `review comment by <login>` | PR from `comment.pull_request_url`; actor from `comment.user.login`; URL from `comment.html_url`. Never copy `comment.body` or `message` | `pr-review-changes-requested.json` |
| `issue.commented` | same | info | `comment by <login>` | actor and comment URL; never body or `message`; off by default in adapter | `issue-commented.json` |
| `ci.passed` | same | success | `CI passed` | PR from `pr_number`, sha from `head_sha`; never `message`, logs, failure excerpts or instructions | `ci-passed.json` |
| `ci.failed` | same | failure | `CI failed: <first check name>` (or `CI failed`) | same metadata and exclusions | `ci-failed.json` |
| `pr.parked_ready` / alert | same | pending | `ready to merge` | PR when supplied; fixture has ticket only | `alert-pr-parked-ready.json` |
| `agent.attention.<slug>` / alert | same | attention; info if `needs_attention=false` or suffix `.resolved` | single-line alert `message`, at most 200 characters | ticket from topic or `source_ticket_id` | `alert-agent-attention.json` |
| `agent.<name>` from `emit_event` | same | `blocked` / `pause.request`: attention; `unblocked`: success; otherwise info | single-line agent `message`, at most 200 characters | ticket from topic | `agent-blocked.json` |
| `agent.paused` | same | attention | `paused` | ticket | `agent-paused.json` |
| Wake record | derived from **`topic`**, not `topic_class` | same topic rules | same topic rules | `pr_number`, `head_sha`; time from `first_seen_at`; fixture maps to draft PR opened | `wake-pr-opened.json` |
| `system.*`, `executor.*` | skipped | — | — | fleet-internal; mapper returns `null`, tool returns `{ skipped: true }` | `system-branch-push.json` (system case) |
| Other `ticket.<n>.<class>` | safe class, else `custom.unknown` | info | class with dots replaced by spaces; never arbitrary `message` | ticket | `unknown-class.json` |

The mapper strips `ticket.<n>.` from the topic, adds provenance `{system: "aiur", topic, event_id}` when available, and normalizes timestamps and SHA case. `ticketLabel` defaults to the raw id; the tool's `ticketPrefix: "AIUR-"` supplies the display label. `AiurMapOptions.repo` can supply missing repository metadata to direct mapper callers; the tool has no `repo` argument.

## Dedup keys

KTD5 reuses Aiur's identities, expressed as strings in Khala:

| Khala key | Aiur identity it mirrors | Fixture evidence |
|---|---|---|
| `pr:<repo>:<action>:<n>:<sha>` | `{repo, "pr:<action>:<n>", head_sha}` in `events/github_keys.ex:43-46` | `pr-ready-for-review.json`; `pr-merged.json` uses action `closed` |
| `ci:<ticket>:<outcome>:<sha>` | `{"ci", outcome, target <> ":" <> head_sha}` in `orchestrator/ci_lifecycle.ex:1650-1653` | `ci-passed.json`, `ci-failed.json` |
| `review:<repo>:<n>:<review_id>` | `{repo, "pr_review:<n>", review_id}` in `events/github_keys.ex:98-102` | `pr-review-changes-requested.json` with `AiurMapOptions.repo: "aiur-team/aiur"` |
| `aiur:<event_id>` | published bus record `id`, or wake record `event_id`, when a richer identity cannot be formed | `agent-blocked.json`; unmodified review and wake fixtures |

Aiur source citations refer to commit `0972f0297` under `/home/everdred/github/everdred/aiur/src/lib/aiur/` (read-only). Review keys require a submission state, PR URL number, repository and `comment.id`; the review fixture has no repo, so forwarding it unchanged yields `aiur:88123`. The wake fixture also lacks repo and falls back to `aiur:88123`; do not assume every partial projection can deduplicate against a richer bus record.

Readers keep the first event per key in timeline order. The emitting session derives its Matrix transaction ID from the key for send retries; a second agent's send is deduplicated by readers using the shared key. Keyless events are not deduplicated.

## Option B (supported now): agent forwarding

An Aiur worker joins its Khala channel with `khala_join` in the same live session. After its own `emit_event`, or when it sees a PR/CI event, it calls `khala_event` with `{ aiur: <event>, ticketPrefix: "AIUR-" }`. Forward the full available event record, including its published `id`; an `emit_event` enqueue acknowledgement alone is not that record.

Aiur's vocabulary is defined in `codex/dynamic_tool/emit_event.ex:12-53`: `progress`, `progress.<slug>`, `decision.<slug>`, `blocked`, `unblocked`, `attention.<slug>`, `attention.resolved`, `pause.request`, and `custom.<slug>`. `agent_runner/tool_executor.ex:355-372` constructs `ticket.<id>.agent.<name>` and the payload's `message`, `name`, `issue`, and agent source. Aiur caps bare progress emits at **2 per turn** (`codex/dynamic_tool/emit_event.ex:55`); forwarding does not bypass that cap. `system.*` and `executor.*` return `{ skipped: true }`.

The [C7 tool contract](../build/m1/contracts.md#c7-mcp-tools-packagesagentsrcmcptoolsts), implemented in [MCP tools](../../packages/agent/src/mcp/tools.ts) and [event resolution](../../packages/agent/src/events/emit.ts), is:

| Tool | Input | Result / errors |
|---|---|---|
| `khala_event` | `{ event?: object, aiur?: object, ticketPrefix?: string (0..16) }`, exactly one of `event` / `aiur` | `{ eventId }` or `{ skipped: true }`. Errors: `invalid_event` (with `path`, `code`), `not_connected`, `send_failed` |

There is no channel argument: the live agent session supplies the joined channel. The merged MCP dispatcher also returns `session_unknown` when it cannot resolve the calling session; this is additional to the C7 event errors.

### Example: review requested

An Aiur worker has just moved PR #412 to ready for review. Aiur publishes `ticket.395.pr.ready_for_review` ([fixture](../../packages/contracts/fixtures/aiur-events/pr-ready-for-review.json)). The worker forwards that exact fixture:

```json
{
  "tool": "khala_event",
  "arguments": {
    "aiur": {
      "id": 88123,
      "topic": "ticket.395.pr.ready_for_review",
      "action": "ready_for_review",
      "timestamp": "2026-10-01T10:09:00Z",
      "pr": {
        "number": 412,
        "draft": false,
        "html_url": "https://github.com/aiur-team/aiur/pull/412",
        "user": {
          "login": "kweaver"
        },
        "head": {
          "ref": "feat/events-cursor",
          "sha": "3F9C2AB0D1"
        },
        "base": {
          "repo": {
            "full_name": "aiur-team/aiur"
          }
        }
      },
      "ticket_observation": {
        "occurred_at": null
      }
    },
    "ticketPrefix": "AIUR-"
  }
}
```

Both humans see one pill: `AIUR-395 review requested · feat/events-cursor · 10:09` (time shown in UTC for this example). The formatter's AE1 assertion is exactly `AIUR-395 review requested · feat/events-cursor`; the renderer adds the time. A retry, or a second agent forwarding the same event, adds no second visible pill: both derive `key = pr:aiur-team/aiur:ready_for_review:412:3f9c2ab0d1`.

## Option A (future): process-level adapter

A future Aiur-side subscriber would forward this topic allowlist into a configured channel per run or repository:

- `ticket.*.pr.opened`
- `ticket.*.pr.ready_for_review`
- `ticket.*.pr.merged`
- `ticket.*.pr.parked_ready`
- `ticket.*.ci.passed`
- `ticket.*.ci.failed`
- `ticket.*.agent.attention.*`

These topics come from `executor_bindings.ex:23-33`; this is a selected subset, not all Executor bindings (which also include pause/error/retry signals). `branch.push` is noisy and off by default. Review comments, issue comments and ordinary agent progress are also off by default.

The prerequisite is a Khala emitter with its own long-lived Matrix device, or an outbox hand-off to a live agent session. Neither exists in M1; this needs a Khala decision first. A separate process cannot send as the agent's in-memory, process-lifetime device. **There is no `khala event` CLI** ([C7](../build/m1/contracts.md#c7-mcp-tools-packagesagentsrcmcptoolsts)); the plan's earlier CLI-based recommendation is superseded by the M1 contract.

## Safety

- Khala never depends on Aiur at build or run time; the mapper only knows JSON shapes. An integration uses the existing tool rather than importing Khala code into Aiur.
- Events carry a summary only, never comment bodies, CI logs or CI instructions. Forward only compact progress summaries as agent/alert `message` values.
- Attribution is always the Matrix sender. `actor` is a display hint and cannot establish identity or authority.
- Events never wake agents in this version. They are attributed context on the next read.
- Khala credentials live with the emitting agent session, never in Aiur. A future adapter must respect its chosen device/session ownership model.
- Aiur's tracked-ticket and self-loop filters still apply upstream (`events/publisher.ex`, especially its filtering gates; `events/sanitizer.ex:136-143` stamps and sanitizes GitHub payloads before publication). Forwarding does not widen subscriptions or override those filters.

## Open questions

These are events plan Open Questions 1, 2, 4, 5 and 6, with defaults retained and the dropped CLI prefix flag expressed as the M1 tool argument:

1\. **Ticket label.** Should a ticket render as `AIUR-395`, `#395` or `Agent-123`? **Default:** raw id in the contract, prefix supplied by the emitter (`ticketPrefix`; the Aiur adapter uses `AIUR-`). Aiur's `TicketObservation.tracker_identity` could provide a canonical label later.

2\. **Should events about an agent's own ticket or PR wake it?** For example, `ci.failed` on its PR. **Default:** no, for now. Revisit with the M2 listener modes.

4\. **Distinct `pr.review_requested` kind.** Aiur drops GitHub's `review_requested` action today. **Default:** map `pr.ready_for_review` to summary `review requested`. If Aiur later publishes `pr.review_requested`, the kind passes through 1:1 without a Khala change.

5\. **Update-in-place.** Should a pending→passed transition replace the earlier event with `m.replace`? **Default:** no. Every transition is a new event, preserving history.

6\. **Rate limiting noisy emitters.** Aiur caps progress emits at 2 per turn. **Default:** no Khala cap in v1; the future adapter forwards only the topic set above.
