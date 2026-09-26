# Channel creation requests

The owner-facing creation adapter for agent channel-creation requests (RD9A, `channel-create-workflow`, in
`docs/product/internal-mode/room-discovery.md`). A creation request reuses the shared `../channel-access` inbox and
the `../approval-decision` dialog. This module supplies only the creation facts and copy that
`channel-access/model.ts` and `controller.ts` render for `operationKind: 'create'` rows. There is no second inbox
or modal.

- **Approval creates the channel.** Approving creates exactly one secret channel that the owner owns, and it
  authorizes admission only for the requesting session. The agent joins later, when its own connector picks the
  approval up. The progress rows keep "Creating the secret channel" and "Waiting for the agent’s connector" apart
  from "Connected".
- **The title is the agent's text.** The proposed title appears only as an unverified fact. It is never the
  dialog question, the row subject, or a label, and it cannot add controls or markup.
- **The server stays authoritative.** Channel creation, reconciliation and the requester-only grant live in
  `packages/messaging/src/channel-create/`. Each backend injects only its create adapter: hosted in
  `apps/control/src/composition/agent/channel-create.ts`, internal in
  `apps/internal/src/composition/channel-discovery/service.ts`.

```sh
pnpm --filter @khala/web exec vitest run --config ../../vitest.config.ts src/features/channel-create
```
