# UI planning grounding — 2026-09-16

Planning evidence, not a completed client experiment or runtime acceptance report. Khala currently contains documentation rather than the proposed application packages. Inspected HEAD: `6d4694173eff9b0832f4c3a2cdb90b4281fcccd9`. Ticket proposal and plans are uncommitted working-tree inputs at this point.

## Aiur application reference

Aiur HEAD: `1f618cddf601a0b6d79bc1197579746b7584a64c`. Archon HEAD: `c7d3254097acaa02eed1e3be6fd8fbf06c0e8128`. Paths below are relative to Khala's repository root.

| Inspected source | Concrete use in Khala plans |
|---|---|
| `../aiur/src/lib/aiur_web/components/operator_control_center/dashboard_shell.ex` | Separate topbar/sidebar chrome, route context and content slots; writable controls; navigation collapse; mobile navigation; no feature ownership inside shell |
| `../aiur/src/priv/static/dashboard.css` | Application tokens; desktop 960px breakpoint; 15rem nav and 2.6rem collapsed rail; 75rem content measure; Bungee route heading; 18px nav icons; 16/24px panel radii; semantic ink/fill pairs |
| `../aiur/src/lib/aiur_web/components/operator_control_center/decision_inbox.ex` | Review list, filter chips, counts, selected detail and explicit partial/unavailable state |
| `../aiur/src/lib/aiur_web/components/operator_control_center/decision_action.ex` | Inline command feedback, native form controls, writable gating; **do not copy its dismiss/proceed semantics into Khala release policy** |
| `../aiur/src/lib/aiur_web/components/operator_control_center/agent_log_modal.ex` | Attributed log rows, local composer/error state and unique writable-target checks; Khala conversation is a page, not necessarily this modal |
| `../aiur/src/lib/aiur_web/components/operator_control_center/usage_summary.ex` | Explicit locked/loading/empty/unavailable/partial/stale states; locked state does not expose protected values |
| `../aiur/src/test/aiur_web/dashboard_css_theme_test.exs` | Token/contrast regression lessons; source-based expectations do not substitute for rendered Khala checks |
| `../aiur/website/public/images/dashboard/units-dark.png` | Viewed actual repository image: sticky AIUR chrome, left nav, aligned route heading, rounded work panels, compact state chips, highlighted actionable rows |
| `../archon/site/index.html` | OAuth/account entry and copied agent-prompt affordance only; marketing flow field is not Khala application layout |

Read-only live checks: GET `http://127.0.0.1:4000/` returned 401; GET `http://127.0.0.1:4001/` was refused. No authentication bypass or runtime change was attempted. The rendered reference is the repository screenshot, not a newly captured live dashboard. The screenshot can lag source; source wins on details.

## Application design contract

Khala should be recognizable as one Aiur left-nav page. The route heading is **Khala**, the topbar identity remains Aiur, and content uses the dashboard's layout/surfaces rather than a large product splash. Standalone shipping supplies this chrome. A future embedding host can supply chrome, theme and navigation without duplicating it inside the content mount. This does not add a current Aiur integration, cross-origin credential sharing, iframe bridge or a new plugin framework.

Standalone navigation exposes only available Khala destinations. Do not reproduce Units/Build Order/etc. as inert navigation to imply integration. Use a route-level channel list and the conversation/review workspace inside the content slot. Application controls are truthful about their scope; an agent delivery pause is not Aiur's global fleet pause.

## External implementation guidance

- Element's legacy customisations are deprecated; upstream directs new work to the current Module API. Historical component overriding offers no stable internal state/props guarantee. This changes KHA143: assess current extension hooks, not archived snippets. [Customisations](https://web-docs.element.dev/customisations.html), [deprecated module system](https://web-docs.element.dev/deprecated-modules.html).
- Element config can set brand/themes but explicitly stops short of complete private labeling. Its current runtime module loading is distinct from old build-time configuration. Test actual hooks against the selected release. [Configuration](https://web-docs.element.dev/config.html).
- `matrix-react-sdk` is archived and merged into Element Web; it is not a maintained standalone component-kit dependency. [Repository](https://github.com/element-hq/matrix-react-sdk).
- The Matrix JS SDK uses Rust crypto WebAssembly and warns against simultaneous client instances sharing an IndexedDB crypto store. KHA111 owns the store lease; composition and embedding must reuse that lifecycle rather than instantiate per route. [SDK reference](https://matrix-org.github.io/matrix-js-sdk/).
- React's external-store hook requires an unsubscribe function and a stable snapshot. Feature controllers can expose immutable cached view snapshots while normal drafts/selections remain local state. No global Redux-like store is implied. [React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore).
- Netlify's Vite deployment guide describes a static build and a rewrite for SPA history routes. Public discovery/control endpoints must precede the SPA fallback, owned by KHA131. [Vite on Netlify](https://docs.netlify.com/build/frameworks/framework-setup-guides/vite/).

Technical recommendation after the dashboard requirement: evaluate thin React/TypeScript presentation on the selected maintained messaging SDK against Element plus its supported Module API. A thin UI better preserves Aiur page composition; an Element adaptation wins only if real seam, upgrade and no-setup evidence shows lower total ownership. KHA143 makes the evidence-backed selection. Neither option has been runtime-tested in this planning pass.

## Candidate dependency observation

Direct registry metadata read on 2026-09-16 returned these candidate versions. These are available package observations, **not a tested compatible lockfile**; KHA101/dependency owner must install and validate the chosen set, and KHA143 can reject them. No worker independently rewrites the root lockfile.

| Package | Observed version | License metadata | Node engine metadata |
|---|---|---|---|
| react / react-dom | 19.3.0 | MIT | React `>=0.10.0`; react-dom unspecified |
| vite | 8.3.0 | MIT | `^20.19.0 || >=22.12.0` |
| typescript | 7.0.2 | Apache-2.0 | `>=16.20.0` |
| vitest | 5.0.1 | MIT | `^22.12.0 || ^24.0.0 || >=26.0.0` |
| @playwright/test | 1.63.0 | Apache-2.0 | `>=20` |
| matrix-js-sdk | 42.4.0 | Apache-2.0 | `>=22.0.0` |
| dompurify | 3.4.15 | MPL-2.0 OR Apache-2.0 | unspecified |
| marked | 18.0.13 | MIT | `>=20` |

Metadata sources are each package's `https://registry.npmjs.org/<package>/latest` endpoint, not an install performed here. Dependencies are illustrative for the comparison, not a mandate to add every package. Safe text rendering needs no Markdown dependency; enabled Markdown must use a maintained parser plus sanitizer with an explicit no-remote-content policy. Licensing inventory includes assets/fonts and transitive dependencies, not just this table.
