---
title: "feat: Pick any palette colour per channel, resolved per viewer"
date: 2026-10-23
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin: https://github.com/aiur-team/khala/issues/1315
---

# feat: Pick any palette colour per channel, resolved per viewer

## Summary
Rework #1309. Each human picks any colour of the channel palette for themselves and their own agents; nothing is disabled. Each viewer's page resolves collisions locally: the viewer's own picks win, others are remapped to free colours. The palette is the 10 base colours, grown by one ring of 10 shades per 10 participants.

## Key Technical Decisions
- **Palette keys** `red` (base) and `red.N` (N 1..8, the Nth shade from the existing variant generator). Stored in the same `com.khala.colors` member content; old numeric agent variants decode as absent and fall back to defaults.
- **Palette size** `10 * ceil(max(n, 1) / 10)` for n participants (humans, agent-only owners, agents), ring-major order. Always >= n, so a free key always exists.
- **Resolver** `resolveChannelColors(viewerOwnerId, members)`. Rank: viewer-owned first, human before agent, then id. Pass 1: each pick claims its key if free. Pass 2: the rest walk the palette from their pick's index (else `fnv1a(id) % size`) to the first free key. Pure; input order does not matter.
- **Shade rendering** a shade is its own `solid`/`tint`/dark bubble (white text >= 4.5:1 by construction); the light bubble keeps the base colour's.
- **Deleted** tiers 1-2, `nearestColors`, `assignAgentVariants`, `AGENT_VARIANT_COUNT`, disabled swatches, the "Use profile color" button, `data-kh-tier` rings.

## Implementation Units

### U1. Contracts: channel colour keys
**Files:** `packages/contracts/src/m1/colors.ts`, `packages/contracts/src/m1/colors.test.ts`
**Approach:** `ChannelColorKey`, `isChannelColorKey`, `CHANNEL_SHADE_COUNT`; `ChannelColors` holds keys; decoder drops invalid keys.
**Test scenarios:** `teal`, `teal.8` valid; `teal.0`, `teal.9`, `#fff`, numbers invalid; mixed content keeps only valid entries.

### U2. Resolver and palette
**Files:** `apps/web/src/ui/khala/human-colors.ts`, `apps/web/src/ui/khala/human-colors.test.ts`
**Test scenarios:** 10 members -> 10-key palette, 11 -> 20; viewer takes B's colour and wins, B remapped, B's own view inverse; two others collide -> human/lower id wins; shuffled input gives same map; 35 random members across several viewers never share a key; defaults are unique.

### U3. Wiring and picker
**Files:** `apps/web/src/features/channel/{ChannelScreen.tsx,ChannelColors.tsx,AgentPresencePanel.tsx,members.ts,channel.css}` (+ tests), `apps/web/src/features/timeline/TimelineScreen.tsx` (+ test), `apps/web/src/ui/khala/{Avatar.tsx,khala-app.css}`, `apps/web/src/composition/human/matrix-browser.test.ts`
**Approach:** ChannelScreen builds members (human pick = channel colour ?? profile colour; agent pick = owner's record only) and passes the resolved map to the provider; picker shows the full palette for self and each own agent, no disabled options, no profile-colour button.
**Test scenarios:** picker renders 10 options per group with none disabled and no "Use profile color"; choosing a taken colour calls save; ChannelScreen roster shows the viewer's pick and the remapped other.

## Verification
Targeted vitest for the touched test files; typecheck `@khala/contracts` and `apps/web`.
