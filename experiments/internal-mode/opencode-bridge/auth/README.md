# OpenCode server-auth route verifier

This verifier encodes the OpenCode `1.17.10` boundary established by the
retained server-auth evidence: delivery is admissible only through the SDK
client passed to a plugin in the running TUI process. A successful HTTP call is
not delivery evidence, with or without Basic authentication.

Run the fixture suite:

```sh
node --test experiments/internal-mode/opencode-bridge/auth/verify-route.test.mjs
```

Check a candidate record directly:

```sh
node experiments/internal-mode/opencode-bridge/auth/verify-route.mjs <record.json>
```

The JSON fixtures deliberately keep authentication metadata but contain no
credential values. `unauthenticated-external-all-200.json` is the wrong-
implementation control: every external call succeeded, yet the route must be
rejected because it bypasses the in-process boundary.
