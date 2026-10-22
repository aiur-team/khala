# Secrets guard (Aiur #6) — plan

Content is E2EE, so the server cannot block secrets. Check at the send points instead.

- `packages/contracts/src/m1/secrets.ts`: one conservative pattern list and `detectSecret(text) → kind | null`.
  Kinds: `private_key`, `github_token`, `anthropic_key`, `openai_key`, `aws_access_key`, `slack_token`,
  `google_api_key`, `secret_assignment` (env-style `*_KEY=`/`*_TOKEN=`/`*_SECRET=`/`*_PASSWORD=` with a
  20+ char value that mixes letters and digits and is not bare hex/UUID).
- Agent: `khala_send` and `khala_event` (the only agent send paths) throw `KhalaClientError('secret_detected', …, { kind })`
  before sending; the tool returns `{ error: "secret_detected", kind }`. No override flag.
- Web: `ChatComposer` (the only composer) shows an inline `role="alert"` warning and disables send while the draft matches.
- Docs: `AGENTS.md` tool table error list and guidance. `SKILL.md` already says never paste secrets; left unchanged
  to avoid a plugin release bump. `docs/settings.md` has no tool error list.
- Tests: both directions in `secrets.test.ts` (tokens flagged; prose, commit SHAs, UUIDs, `$VAR` references,
  placeholders, public keys allowed), plus tool and composer regression tests.
