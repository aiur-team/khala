# Independent platform plan review

2026-09-16. Reviewer: brand/product agent, independent of platform plan author, same serving model family. Read plans101/102/108/109/131/140 and current UI/105/106 seams. Applied ce-doc-review headless coherence, feasibility, security and adversarial technical lenses inline, report-only as assigned. No parent files edited. No execution or different-model corroboration claimed. Cross-model shell-out omitted under bounded parent assignment; not a failed runtime experiment.

## Findings

| ID | Severity / confidence / tier | Evidence | Consequence and proposed resolution |
|---|---|---|---|
| UI-P1 | P1 / 100 / gated_auto |131 U3: “Use explicit per-domain entrypoints or build-time discovery limited to approved registration files”; record gives `.netlify/functions-built` but no generated handler filenames or registration export. |132 cannot implement its human handler bundle without choosing the backend publication architecture. Pin allowed registration filenames/export signature, generated output directory versus Netlify input directory, HTTP route mapping, and exact `build:functions` invocation. Test duplicate/unknown registration and SPA precedence. |
| UI-P2 | P2 / 100 / safe_auto |102 verification invokes `pnpm --dir experiments/backend test` and `check`; owned files omit `experiments/backend/package.json` and lockfile. |Reproduction requires undeclared manifest work. Add isolated package manifest/lock and exact scripts to102 ownership/U1, or use101 root runner with named input. |
| UI-P3 | P2 / 75 / gated_auto |109 U2: “Document consistency boundary”; U3: “Restore without contacting real users”. |The important safety outcome lacks a mechanical sequence. Specify stop/quiesce writes for rehearsal backup (or a proven coordinated snapshot), isolate restored service network before boot, prohibit active federation/connector consumers, and test failed isolation before restoring server signing identity. This is implementation detail of existing requirements, not a new retention policy. |
| UI-P4 | P2 / 100 / safe_auto |101 U1 creates eight package manifests, but its Files list names only root manifests/compiler; worked scripts omit new test:integration. |Declare the eight manifest files and initial compiler/build/test config ownership so feature workers do not race initial package setup. Reflect the final runner contract in worked record. |

## Verified seams and limits

101 now owns Playwright integration discovery;137 owns separate conformance/end-to-end Vitest commands. Root140 explicitly requires live existing sessions and wrong-build evidence blocks acceptance.131 correctly keeps persistent subscriber out of Netlify, uses one-key CAS and unknown outcomes, and distinguishes preview namespaces from actual site isolation.108 preserves server_name and signing key identity and gates production domain/hosting.109 does not claim server backup restores device keys or agent side effects.

No additional blocker was found in102 bounded backend evaluation or140 evidence-only acceptance scope. This is a review of plans, not validation of upstream runtime assumptions. Source/version claims remain refreshable at worker pickup and SDK/browser/headless behavior requires141/142 evidence.

Review complete.

## Re-review disposition

Re-read parent changes on2026-09-16. UI-P1–P4 are addressed:131 pins the two literal factory files, route registration signature, generated Netlify input and build script;102 owns isolated manifest/lock;109 requires verified egress denial and quiescence before restoring identity;101 declares all eight initial package/config boundaries and integration script.

131 direct invocation is explicitly inside the same method/auth/route validation wrapper, with tests covering rewritten and direct function URLs. Missing producer yields unavailable503; existing malformed producer fails build; required absent producer blocks production acceptance. Exact normalization behavior remains a worker implementation detail covered by the required direct-invocation test, not an alternate authentication route. No remaining actionable finding from this review. None of these planning corrections proves live Netlify routing, SDK operation or recovery; those remain implementation checks.
