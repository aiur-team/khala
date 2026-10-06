# U14 terminal wake verification

The terminal rung uses the captured agent's controlling TTY and foreground process group before each send, as directed in [the Executor's ownership clarification](https://github.com/aiur-team/khala/issues/1135#issuecomment-6010389018). Pane titles and working directories are not ownership evidence. tmux additionally requires pane ancestry, normal input mode, and synchronization off.

## Verified contracts

- tmux 3.7b is installed in the agent workspace. A disposable detached tmux pane running an ownership-probe helper confirmed that the Linux `/proc/<pid>/stat` TTY encoding matches the pane device, and that the foreground helper is accepted while an unrelated TTY is rejected. No harness was launched and no focus changed.
- WezTerm is not installed here. The JSON, cursor-range and styled-capture contracts were checked against upstream revision `372548295b0b25c9a5400f0ea56f0e89f47e0524` (2026-10-05): [pane list](https://github.com/wezterm/wezterm/blob/372548295b0b25c9a5400f0ea56f0e89f47e0524/wezterm/src/cli/list.rs), [get-text](https://github.com/wezterm/wezterm/blob/372548295b0b25c9a5400f0ea56f0e89f47e0524/wezterm/src/cli/get_text.rs), and [styled renderer](https://github.com/wezterm/wezterm/blob/372548295b0b25c9a5400f0ea56f0e89f47e0524/lua-api-crates/termwiz-funcs/src/lib.rs). This is source-contract verification, not a live WezTerm version or wake result.
- macOS `ps -o tty=,pgid=,tpgid=` is covered by parser tests and checked against [Apple's field definitions](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/keyword.c); it was not run on macOS.
- The empty-prompt patterns and dim styling use the [U38 captured evidence](../build/multi-harness/spikes/terminal-hosts.md). Cursor columns reject whitespace drafts; dim styling rejects a typed copy of a placeholder with the cursor moved Home.

## Regression coverage

Tests spawn fake tmux and WezTerm executables to assert exact literal argv and a separate Enter/carriage return. They exercise ownership, consent, busy/recent activity, PID reuse, copy mode, synchronization, drafts, cursor columns, process death, nonce verification and two-failure disablement. Hostile inbox text never enters terminal argv.

The WezTerm styled-row test models `lines_to_escapes`' row CRLF, attribute reset and the CLI's final LF. It failed before framing normalization and passed after the fix. A driver test covers the same format before literal insertion and before Enter.

Once the fixed notice is inserted, Enter requires the exact notice on the original row at its expected ending column. A narrow pane that wraps it, or a changed composer, fails closed and leaves the notice unsubmitted; the missing prompt-hook nonce then counts as a failure. Neither transport switches focus or uses a shell for terminal commands.

## Live acceptance

U36 (#1158) owns real tmux and WezTerm wake rows, including WezTerm binary version, draft preservation and focus checks. These local results do not claim R2 parity or accept any live-host gap. Older WezTerm without `tty_name` or cursor coordinates reports an unavailable rung rather than sending without evidence.
