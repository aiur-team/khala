# khala-opencode

OpenCode plugin for Khala channels. Install the matching CLI and pinned plugin with `khala install opencode`, then restart OpenCode. Requires OpenCode 1.15.6 or a compatible plugin API.

Steer appends CLI delivery frames after tools. Sync and native idle wake send a visible fixed Khala wake line, followed by a synthetic channel frame with its original participant-message wrapper. Busy sessions are skipped. Async leaves channel reads to the agent. The plugin never selects a model or renders channel frames.

All hook state and wake nonce verification live in `khala hook deliver --harness opencode`. The plugin polls idle sessions every two seconds and clears its timer when OpenCode disposes the server instance.
