---
title: "feat: Per-channel human colour and per-agent colour variants"
date: 2026-10-22
type: feat
issue: aiur-team/khala#1308
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# feat: Per-channel human colour and per-agent colour variants

Closes #1308.

## Summary

A human can override their profile colour in one channel, and pick a colour variant for each of their own agents there. Agents default to distinct variants, and the picker disables variants a sibling already uses and base colours another human in the channel already uses. Hosted only for storage; local gets the collision-free agent defaults.

## Problem Frame

Today each human has one profile colour (`packages/contracts/src/m1/colors.ts`, 10 ids). Since #1075 every agent wears exactly its owner's colour, so a human's agents are indistinguishable by colour. The per-viewer resolver (`apps/web/src/ui/khala/human-colors.ts` `resolveHumanColors`) already keeps different humans visually apart by moving a displaced human to the nearest free colour or tier.

## Requirements

- R1. A human can set a colour for one channel; their profile colour stays the default elsewhere and when unset.
- R2. In the channel roster, the human can pick each of their own agents' colours, only from variations of their channel colour.
- R3. Each of a human's agents defaults to a distinct variation, the same on every client.
- R4. Within one human's set (human = variant 0, plus agents), the picker disables variants already used.
- R5. Only the owner can change their own and their agents' colours, enforced by the room, not just the UI.
- R6. Contrast holds in both themes; the picker is keyboard-operable with labels.

## Key Technical Decisions

- **Storage: the human's own `m.room.member` content, key `com.khala.colors`.** Value `{ color?: HumanColorId, agents: { [agentMatrixUserId]: variantIndex } }`. Same mechanism as per-channel names (#1097) and `com.khala.listening_mode`. The homeserver accepts a member event only from that member, so only the owner can write it (R5). Clients honour an `agents` entry only when the agent's `ownerId` is that human, so a human cannot recolour someone else's agent. No control-plane or server change.
- **Variants are computed, not hand-tuned.** `variantColor(resolved, index)` derives variant `i` from the resolved base colour by a fixed table of hue offsets and lightness steps (9 variants, index 0 = the base itself), then darkens until white text is at least 4.5:1. The bubble is a 30% mix into the surface, so a darker swatch only raises bubble contrast. A unit test checks every palette colour × tier × variant for contrast and distinctness.
- **Default assignment:** stored indices win when valid (1..8) and unique within that human; remaining agents, ordered by participant id, take the lowest unused index. Deterministic on every client. Saving from the picker persists the whole current assignment, which then makes it stable.
- **Cross-human rule:** two humans may share a profile colour today (the resolver displaces one per viewer). The per-channel picker disables base colours whose effective channel colour belongs to another human in that channel. The global profile picker is unchanged.
- **Hosted first.** Local channels hold one human, so cross-human collisions do not arise; local agents get the distinct default variants for free (derivation is client-side). Writing per-channel colours locally needs a helper route and store change; deferred.

## Implementation Units

### U1. Contract: member key and decoder

**Goal:** `CHANNEL_COLORS_MEMBER_KEY`, `ChannelColors` type, lenient `memberChannelColors(content)` that drops invalid colours and indices, and `AGENT_VARIANT_COUNT`.
**Requirements:** R1, R2, R5
**Files:** `packages/contracts/src/m1/colors.ts`, `packages/contracts/src/m1/colors.test.ts`
**Test scenarios:** valid content decodes; invalid colour dropped; index 0, out-of-range, non-integer dropped; non-object content gives null.

### U2. Variant colours and assignment

**Goal:** `variantColor`, `assignAgentVariants`, and agent entries in the resolved colour map.
**Requirements:** R2, R3, R4, R6
**Dependencies:** U1
**Files:** `apps/web/src/ui/khala/human-colors.ts`, `apps/web/src/ui/khala/human-colors.test.ts`
**Approach:** `resolveHumanColors` takes per-human channel colour as the human's colour input (viewer included). `useHumanColor` gets an optional agent id looked up before the owner.
**Test scenarios:** variant 0 equals base; all variants ≥ 4.5:1 with white text and pairwise distinct; three unassigned agents get 1,2,3; stored {A:2} plus unassigned B gives B=1; duplicate stored index keeps the lower participant id; an entry for an agent of another owner is ignored.

### U3. Hosted read/write ports

**Goal:** `channelColors(roomId, userId)` reads the key; `setChannelColors(roomId, value)` re-sends the viewer's own member event with the key, spreading existing content. Re-render reuses `subscribeListeningModes` (any member-state change).
**Requirements:** R1, R2, R5
**Files:** `apps/web/src/composition/human/matrix-browser.ts`, `apps/web/src/composition/human/application.ts`, `apps/web/src/main.tsx`, `apps/web/src/composition/human/matrix-browser.test.ts`
**Test scenarios:** write keeps displayname and other keys; refuses when not joined.

### U4. Rendering and picker

**Goal:** agents render in their variant (avatar fill, bubble, name hue); owner badge keeps the owner colour. A "Colours" popover on the viewer's roster row: channel colour radiogroup (plus "Profile colour" reset), and one variant radiogroup per own agent. Taken options are `aria-disabled` and skipped by arrow keys.
**Requirements:** R1–R4, R6
**Files:** `apps/web/src/features/channel/ChannelScreen.tsx`, `apps/web/src/features/channel/members.ts`, `apps/web/src/features/channel/AgentPresencePanel.tsx`, `apps/web/src/features/channel/ChannelColors.tsx`, `apps/web/src/ui/khala/Avatar.tsx`, `apps/web/src/features/timeline/TimelineScreen.tsx`, `apps/web/src/composition/human/room.tsx`, tests beside them.
**Test scenarios:** picker disables another human's channel colour; a sibling's variant is disabled; choosing a variant calls the save handler with the full assignment; arrow keys skip disabled radios.

## Scope Boundaries

### Deferred to Follow-Up Work
- Local per-channel colour writes (helper route plus store).
- Persisting default variants automatically at agent join (today a new unassigned agent with a lower participant id can shift other unassigned agents until the owner saves once).

## Verification Contract

Targeted vitest for touched files; typecheck for `packages/contracts` and `apps/web`. No Playwright visual runs (host memory); snapshot changes only for views changed, if any.
