# Session-safety probe

After the live timing trials, the proof fixture was hardened with a persisted
admitted-session binding and an in-flight lease owner/status. The deterministic
probe exercises the failure paths without sending private transcript content to
a model:

```text
$ node experiments/interactive-cli/opencode/probe/session-safety.mjs
{
  "result": "PASS",
  "checks": [
    "wrong-session idle leaves the batch pending",
    "wrong-session send cannot acknowledge another session's lease",
    "a later same-session batch remains eligible",
    "failed prompt submission remains uncertain and unacknowledged",
    "wrong-session async read fails closed",
    "wrong-session transform preserves the prefilled text byte-for-byte"
  ]
}
```

This is executable fixture evidence, not a substitute for the product ticket's
future live two-TUI acceptance. It proves the committed probe fails closed on
the session and acknowledgement mistakes that a live acceptance must detect.
