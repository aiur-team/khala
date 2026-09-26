# Approval decision dialog

The shared owner-decision shell from RD4B (`channel-access-inbox`) in
`docs/product/internal-mode/room-discovery.md`. Channel access, channel
creation, and pairing (`pairing-approval-ui`) all decide through
`DecisionDialog`. None of them copies it.

- **Adapters supply facts, the shell supplies behavior.** An adapter turns its
  own safe projection into a `DecisionPrompt`. That prompt holds verified facts
  first, then untrusted labels, fixed capabilities, notices, and progress. The
  shell owns focus, keyboard handling, and status for every adapter.
- **Plain text only.** Every prompt field is a string rendered as text.
  Untrusted labels are marked "unverified" and wrapped in `<bdi>`. Agent text
  can't create controls, links, or markup.
- **Modal, never self-opening.** Focus moves into the dialog when it mounts.
  Tab and Shift+Tab cycle inside it, and Escape or Close dismisses it. Focus
  returns to the element that opened it. If that element is gone, the host's
  `restoreFocus` runs. The host decides when to mount the dialog. The shell
  never opens a queued request.
- **Honest status.** A `role="status"` live region stays mounted.
  `submitting` disables the decision buttons, and `retryable` raises an alert
  and offers the same decision again. `reloading` also disables them while a
  changed request loads, and `refreshed` means it has loaded and can be decided
  again. `decided` and `blocked` remove both decisions.
- **Narrow layouts.** The details scroll, while the header and actions stay on
  screen. Every button is at least 44 by 44 CSS pixels.

`pairing-fixture.ts` is a test-only pairing adapter. It proves that the shell
serves pairing unchanged. The production pairing adapter belongs to
`pairing-approval-ui`.

Run the checks with:

```sh
pnpm --filter @khala/web exec vitest run --config ../../vitest.config.ts src/features/approval-decision
pnpm --filter @khala/web exec node --import tsx --test src/features/approval-decision/approval-decision.browser.spec.ts
```
