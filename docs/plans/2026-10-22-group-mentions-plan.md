# Group mentions: @channel, @humans, @agents

Operator request: "give me an @channel (everyone), @humans and @agents tags to ping different groups accordingly".

## Design (smallest change, reuses existing mention plumbing)

- Mentions are plain text (no `m.mentions`), so a group mention is the literal token with the same word boundaries as name mentions. Agents' `khala_send` text works unchanged.
- Web `segmentMentions` (`apps/web/src/features/timeline/mentions.ts`) also yields `{ group }` segments. Groups win over a same-named label; longer labels (`@channel-ops`) still win.
- Rendering: highlighted, non-clickable `kh-mention` span.
- Composer autocomplete: `filterMentionTargets` appends `@channel`/`@humans`/`@agents` after people, prefix match only, only when someone can be mentioned. Not added to the chips bar.
- Human notifications: `mentionsViewer` treats `@channel` and `@humans` as mentioning the (human) viewer; `@agents` does not.
- Agents: `mentions()` in `packages/agent/src/events/receive.ts` treats `@channel` and `@agents` in a message as mentioning the agent. That single function feeds `wakesAgent` (Sync wake, quiet Stop delivery for Claude/Codex/Cursor, OpenCode, the ladder and `khala watch`) and `khala_read` `mentionsOnly`. Wakes remain the constant, content-free nudge.
- Docs: AGENTS.md, SKILL.md, docs/settings.md, `khala_read` description.

## Not done

- No `@everyone`/`@here` aliases, no chips, no reserved-name change.

## Verification

Unit tests in `mentions.test.ts`, `mention-autocomplete.test.ts`, `mention-notifications.test.ts`, `receive.test.ts`; agent-instructions test; typecheck web and agent.
