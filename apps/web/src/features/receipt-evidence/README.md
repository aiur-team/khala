# Receipt evidence

The single truthful vocabulary and presentation for delivery receipt evidence,
shared by the channel timeline, review, the agent presence panel and agent
controls. Contract: [read receipts](../../../../../docs/product/internal-mode/read-receipts.md).

Khala cannot observe cognition, so no label here says "read". Each receipt kind
names the boundary its producer crossed:

| Kind | Label |
|---|---|
| `transport_written` | Delivered to connector |
| `harness_queued` | Queued at agent session |
| `context_consumed` | Added to agent context |
| `agent_acknowledged` | Batch token returned |
| `completed` | Agent turn completed |

"Batch token returned" always carries its boundary as a programmatic
description and a keyboard help control: a later Khala call returned the
token for the batch, which does not prove the agent acted on, received,
understood or completed the message.

- **`vocabulary.ts`** has the labels, the capability copy for
  `unknown`/`unsupported`/`batch_token_next_call`, and the one canonical order:
  ascending kind code, then timestamp and receipt ID as same-kind tie-breakers.
  Facts are a set, never a progress state.
- **`model.ts`** strictly decodes the owner-gated
  `GET /api/v1/channels/:channelId/receipts` body over the v1/v2 receipt union.
  A malformed envelope reads as `unavailable`. A malformed or unverifiable fact
  makes the read `partial` and is dropped, so it is never shown as absent. It
  groups facts into units. Releases whose token returns share one evidence
  reference form one batch unit with a single token-return status, and every
  other release is its own unit. A unit with one release and one message is
  inline.
- **`controller.ts`** models access as `loading | ready | partial | unavailable`.
  A failed read keeps the facts already shown. Only a `ready` read may confirm
  "No token-return fact". The first successful read is hydration and stays
  silent. Each fact first observed after it produces one polite announcement.
- **`ReceiptEvidence.tsx`** renders inline facts, batch/release groups with a
  stable DOM target and a focusable heading, and the access notice with Retry.

The timeline anchors each non-inline group before its earliest loaded member
row. Each loaded member links to the group with "View batch evidence".
Activating the link moves focus to the group heading, and browser back returns
focus to the invoking link. Because the receipt read is per channel and not
paginated, loading older pages moves a group but never loses it.

Run the checks with:

```sh
pnpm --filter @khala/web test
node --import tsx --test apps/web/src/internal/receipt-evidence.browser.spec.ts
```
