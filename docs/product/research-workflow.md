# Research and planning handoff

Current stage: all 44 per-ticket brainstorm/plan artifacts written across three background agents plus the primary; independent review complete; publication and Executor handoff. Updated 2026-09-16.

## Work owners

- Parent: source recovery, product decisions, prompt-injection synthesis, architecture integration, ticket proposal and cross-document consistency.
- `crypto_identity`: identity/E2EE/security evidence; Matrix and TypeScript connector custody, alternative reusable crypto, historical-report dispositions.
- `transport_protocols`: protocol/substrate/state research; Netlify preferences, Matrix service boundary, actual existing-session notifications.
- `brand_product`: inspected Aiur/Archon branding; existing Matrix UI reuse versus thin custom interface.

Original reports under `docs/research/recovered/` stay historical. Current synthesis must explicitly supersede recommendations that conflict with later product decisions.

## Skill handoff after sign-off

Requested skills were located at:

- `/home/everdred/.claude/plugins/marketplaces/compound-engineering-plugin/skills/ce-brainstorm/SKILL.md`
- `/home/everdred/.claude/plugins/marketplaces/compound-engineering-plugin/skills/ce-plan/SKILL.md`

The paths are local installed workflow sources. Read the applicable skill and its required references at invocation; the planning agents read and applied the workflows and required references. Each ticket retains its Product Contract and enriched candidate/committed implementation units in one canonical artifact.

User-requested sequence: finish research and product choices → propose concrete ticket breakdown → user signs off → run per-ticket `ce-brainstorm` and `ce-plan` → verify completeness for less capable implementation workers.

Do not mistake pending product answers for a blocker to independent research. Do not mistake a draft ticket table for approval. The later user instruction explicitly authorizes transition to local aiurdev execution after the research push; research itself does not execute the service.

## Completion evidence required

- Every research track has a current synthesis, sources, limitations and disposition of relevant recovered findings.
- Product decisions are recorded without turning recommendations into user choices.
- Branding is traced to real Aiur/Archon assets and styles.
- A coherent ticket proposal covers the complete agreed journey, concrete acceptance criteria, dependencies and conditional scope.
- User sign-off is recorded against the specific proposal revision.
- Every approved ticket has a requirements contract and a detailed enriched plan produced through the named workflows, with verification and review evidence.

Planning and product implementation are distinct milestones. See the [plan index](../plans/README.md) and [Executor transition](executor-transition.md). Product-gated plans remain requirements-only; no unperformed runtime proof is represented as passed.
