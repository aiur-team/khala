# Desktop and browser app proof record

Captured on 2026-09-24 for the `desktop-apps` deliverable.

## Result

No target desktop app was installed and no authenticated target browser session was
available on the research host. Consequently, no live `sleep 20` delivery trial could
be run against a user-started app session and no mode is marked Proven. This is a
bounded negative result, not evidence that the documented candidate routes work.

The exact host and executable inventory is in
[`host-inventory.txt`](./host-inventory.txt). Product documentation, CLI availability,
and the presence of a generic browser do not prove that a Khala batch reached the
model context of the intended session.

## Proof threshold

A future evidence bundle for each exact app shape must include:

1. app version, OS, account tier, extension/plugin version, and relevant administrator
   policy;
2. a process/session census showing the user-started session is the only agent process;
3. a channel batch with stable event identities and a batch token, with message bytes
   absent from process arguments;
4. wall-clock timestamps for enqueue, tool start, delivery boundary, model-visible
   context, and acknowledgement during a `sleep 20` tool;
5. restart/reconnect evidence showing an unacknowledged batch is replayed and an
   acknowledged batch is not delivered twice; and
6. a negative test that the route does not create a background agent, hosted model
   session, or second task in place of the user's live session.

For `steer`, delivery must occur at the next tool boundary without aborting the active
tool. For `sync`, it must occur after the current tool or turn. For `async`, the agent
must explicitly invoke the one bounded `khala_read` operation. Transport acceptance,
an MCP notification, or a hook firing is not enough: the batch must be visible in the
target session's model context.

## Authoritative surface references

- Cursor: [hooks](https://cursor.com/docs/hooks),
  [plugins](https://cursor.com/docs/plugins),
  [MCP install links](https://cursor.com/docs/mcp/install-links), and
  [background agents](https://cursor.com/docs/background-agent)
- Anthropic: [local MCP extensions for Claude Desktop](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop),
  [remote custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), and
  [Claude Desktop installation](https://support.anthropic.com/en/articles/10065433-installing-claude-for-desktop)
- OpenAI: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
  [MCP](https://learn.chatgpt.com/docs/extend/mcp),
  [plugins](https://learn.chatgpt.com/docs/plugins), and
  [Codex cloud](https://learn.chatgpt.com/docs/cloud)

These references establish candidate integration surfaces only. They are not copied
into this directory as raw proof because no target-session experiment was performed.
