# Agent names with historical attribution

## Goal

An owner can rename an admitted agent in one channel. The encrypted channel log is the authority for the current name and for the label on each message. A rename is visible once at its actual position in that log. Participant ID, owner ID, approval, and trust remain unchanged.

## Contract

- Name input is optional at attachment. A missing name uses the existing generated agent label. Validation is shared by hosted and local paths: trim and NFC-normalise, cap UTF-8 bytes, refuse controls, bidi/invisible formatting, and role-impersonating reserved names. Same-name agents remain legal.
- A rename is a distinct encrypted event with the target participant ID and new name. The Matrix sender's verified human participant is the actor. The receiver checks the target's authenticated owner ID against the actor's owner ID; a claimed owner ID in event content grants no authority.
- A stable client transaction ID identifies the write until its event ID is known. Retry reuses that ID. No optimistic rename is added to the timeline or participant list; the encrypted event echo is the commit signal.
- The event stream is ordered by the channel transport, deduplicated by event ID, and replayed from the channel's permitted history boundary. Each message gets the name effective at that position. Current participant names come from the same projection. Missing history must be shown as incomplete rather than guessing that the latest mutable participant mapping was always true.
- Agent metadata/read output receives rename events in the same order, under the existing admitted binding and revocation fences. Rename metadata is available without releasing adjacent chat bodies. No rename payload is placed in discovery, URLs, public account metadata, or the content-free agent status route.

## Work units

1. **Encrypted event protocol:** define the versioned rename payload and digest, Matrix and local internal send/read support, authenticated actor and target-owner checks, and idempotent write results. Keep ordinary text and approval selection semantics unchanged.
2. **Replay projection:** merge live and paged events by event ID, replay names in channel order, handle simultaneous renames by event order, and expose current names and immutable bylines to both browser and agent reads.
3. **Owner UI:** use the shared conversation system-event component and real participant panel. Offer an edit control only for the signed-in owner; show validation, authorization, and unknown-outcome errors without phantom labels. Add the optional initial name to attachment/approval.
4. **Example:** show a clearly fictional rename and before/after labels with the same presentational components and no network write.
5. **Proof:** unit tests for validation, authorization, replay, duplication, pagination and retry; hosted and local browser tests; disposable two-human/two-agent flow; typecheck, lint, build and exact-head CI. Record environment-dependent native delivery separately.

## Risks to resolve during implementation

- The existing agent status source contains only the local owner's current binding, while the shared participant UI must show all admitted agents. Membership resolution must provide authenticated owner IDs for every target.
- Matrix's current browser adapter projects every room message as text, and the connector only promotes selected text into the agent inbox. Rename events need a separate projection through those layers so they do not enter the approval queue as chat bodies.
- The latest page alone may start after the last rename. Replay must recover the applicable baseline from allowed older encrypted history before claiming a current name or historical byline.
