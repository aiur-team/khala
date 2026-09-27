# Browser controls composition (KHA-135)

`createBrowserAgentControlsPort` implements KHA-126's `AgentControlsUiPort` over the
protected controls transport (`ControlsClient`). The transport attaches owner authority
out of band; nothing here carries it.

- **Snapshot.** `readSnapshot` decodes the connector's status strictly
  (`decodeControlsStatus`). Effective values are what the connector's dispatcher
  enforces. A null version stays null. An older binding generation never replaces a
  newer one. If the connector is unreachable, the last enforced values stay and the
  connection reads `offline`.
- **Commands.** `submitPolicy` returns only an acknowledgment that decodes and echoes
  the exact command and binding. A lost, malformed or mismatched answer rejects, so the
  panel shows the outcome as unknown and retries with the same command ID.
- **Not offered.** No owner listening-mode or grant route exists on this transport, so
  `listening` is `null` and those commands are refused without a write. Hosted `auto`
  stays gated (G-AUTOMATION): the panel never requests it, and the connector refuses it.
- **Lifecycle.** `registerControls({ client, bindingFor })` keeps one port per room and
  binding for each attached route. Route teardown disposes every port, listener and poll.

`projectControls` builds the serialisable status view from an allow-list: versions,
mode, pause, requested command state, busy and receipt kind. No session ID, owner or
content can reach it.

Without a `ControlsClient`, `registerControls()` stays `unavailable`, which is how
`registerHumanCapabilities` uses it today. See `tests/integration/controls/README.md`.
