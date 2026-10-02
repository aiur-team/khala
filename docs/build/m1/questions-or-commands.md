# M1 build — questions and commands

## Open

- **Q1, design import (gate G-DESIGN).** The design must be imported from `https://claude.ai/design/p/5e62b9a9-39c1-4ca2-9a76-6dff123a088c?file=Aiur+Dashboard.html`. The planner has no `claude_design` MCP in this session. The operator either runs `/design-login` so the MCP can read the project, or exports the project to `~/Downloads`. Blocks KM-180..186 only.
- **Q2, production wipe (gate G-PROD).** The operator approves the backup-then-wipe of production Synapse and Blobs at KM-152 time.

## Answered (operator, 2026-10-02)

- Commit and push to the planning branch: yes. GitHub ticket promotion: yes ("create the actual tickets we will use in the run").
- Model routing:
  - Implementers run Codex Sol 6.1.
  - Design-implementation tickets run Claude Opus 5.5.
  - Planning agents for design work run Claude Opus 5.5.
- Merges: CI is not a gate. Merge quickly with admin override after review. A CI-fix pass every few tickets waits for CI.
- Expected size: more than 20 tickets, maximally parallel. This pack has 44.
