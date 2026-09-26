# Pairing approval

The owner's approve/deny surface for a hosted pairing claim
(`pairing-approval-ui`). It decides through the shared `DecisionDialog` from
`../approval-decision`; nothing here forks its admission semantics.

- **Verified claim only.** `toDecisionPrompt` shows the harness, session
  fingerprint, session ID, generation, target channel, and service from the
  control service's claim projection. Nothing is agent-supplied text.
- **The displayed claim is the decided claim.** A decision carries the
  displayed revision and claim fingerprint. If the claim changes (a new
  generation or session), the held decision is dropped, the dialog moves to
  `refreshed`, and the owner decides again. A stale-claim rejection reloads the
  same way.
- **Denial and expiry are terminal** and never mint a grant. Expiry is
  enforced by a timer and again at decision time, so a stalled timer can't let
  an old approval out.
- **Lost responses retry the same operation ID**, so a decision is never
  recorded twice.

```sh
pnpm --filter @khala/web exec vitest run --config ../../vitest.config.ts src/features/pairing
```
