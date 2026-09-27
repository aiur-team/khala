# Live human-flow proof

This suite is the non-fixture acceptance proof for KHA-132. It uses two isolated
browser contexts, two disposable OAuth identities, the deployed Khala control
routes, and the deployed Synapse/PostgreSQL environment. A pass reads encrypted
raw Matrix events through the creator's own Matrix session and confirms a
separate unadmitted observer gets 403. Both humans see attributed messages allowed by admission:
the default joiner sees content from admission onward, while the creator retains
their earlier introduction history.

`KHALA_E2E_DISPOSABLE_ENV` must be an absolute path to a secret-free JSON
descriptor. Secrets stay in separately named environment variables:

```json
{
  "environmentId": "preview-2026-09-19",
  "appOrigin": "https://deploy-preview.example.test",
  "homeserverOrigin": "https://matrix-preview.example.test",
  "synapseVersion": "1.161.0",
  "oauth": {
    "usernameLabel": "Email",
    "usernamePlaceholder": "email address",
    "passwordLabel": "Password",
    "submitName": "Continue"
  },
  "users": [
    { "usernameEnv": "KHALA_E2E_USER_A", "passwordEnv": "KHALA_E2E_USER_A_PASSWORD" },
    { "usernameEnv": "KHALA_E2E_USER_B", "passwordEnv": "KHALA_E2E_USER_B_PASSWORD" }
  ],
  "observer": {
    "userId": "@observer:approved-server-name",
    "accessTokenEnv": "KHALA_E2E_MATRIX_OBSERVER_TOKEN"
  }
}
```

`usernamePlaceholder` is optional. Use it only if the real provider's email
field has no associated accessible label (Dex v2.43.1 has a visible label but
its `for` attribute does not match the input ID); otherwise the suite uses
`usernameLabel`. Set the labels and button name from the deployed form.

Run only against an operator-approved disposable deployment:

```sh
KHALA_E2E_LIVE=1 \
KHALA_E2E_DISPOSABLE_ENV=/absolute/path/to/khala-live.json \
pnpm test:integration tests/integration/human
```

The suite intentionally throws during discovery when configuration is absent or
malformed. Missing credentials, skipped tests, fixture adapters, or an unavailable
deployment never count as a green result. Playwright output contains the descriptor's
environment ID and service version only; it must never include passwords, access
tokens, OAuth cookies, invitation secrets, or message canaries.
