# Khala: Aiur branding and the product experience

Research date: 2026-09-16. Status: source-backed brand direction and proposed product behavior for owner review; not approved implementation scope.

**Subsequent owner decisions:** maximize existing OSS reuse; Matrix is the preferred candidate for evaluation. Connector-gated review is sufficient: one encrypted room may be readable by the trusted connector, which controls what reaches its agent model. Separate human-review and agent-delivery encryption groups are not required. Review controls must remain unavailable to model tools. The final addendum below updates the UI implementation recommendation accordingly.

**Latest implementation preferences and joining requirement:** prefer TypeScript and Netlify; Railway is acceptable where a persistent service is needed. The participant already has a working agent session, potentially using any model, and should be able to hand that session the invitation link. Do not require switching agents, starting a new session, choosing a model, installing the Aiur runtime, or learning Matrix administration as product prerequisites. Authentication, device/key authorization and human review remain legitimate steps when actually needed. These preferences do not by themselves prove a particular client or hosting combination works; evaluate them in the integration experiment.

**Reading contract:** owner requirements and decisions are called out above and in the recovered scope. Wording such as “recommended,” “proposed,” and the acceptance targets below denotes research recommendations awaiting ticket sign-off. Proposed labels, initial media support, theme default, mobile breadth and precise review policy are not additional instructions from the owner.

## Brand decision already supplied by the owner

Khala is a new Aiur product. Inherit the Aiur identity used by both sibling repositories: the existing blue gradient symbol, Bungee wordmark, Space Grotesk interface text, JetBrains Mono technical details, charcoal dark theme, warm sand light theme, and blue accents. Do not commission a new symbol, introduce a purple AI palette, or substitute Archon's generic document-template theme for the Aiur product identity.

Use the existing symbol beside **KHALA**, following Archon's symbol-plus-product-name lockup. In ordinary copy use **Khala** and **Aiur**. A proposed relationship line is **A product by Aiur**; the exact copy remains a product decision. Archon's existing footer says “built with Aiur,” which describes its construction and is not necessarily the clearest statement of product ownership.

The source repositories are local evidence, not an assertion that every file is deployed. Archon HEAD inspected: `c7d3254097acaa02eed1e3be6fd8fbf06c0e8128`; Aiur HEAD inspected: `1f618cddf601a0b6d79bc1197579746b7584a64c`. Both working trees contain unrelated changes; none of the brand files cited below was reported modified by `git status --short` during this inspection. No sibling files were changed.

## Settled no-setup onboarding correction

The user explicitly defined the ordinary experience: **OAuth sign-in for identity/email, create an optionally named chat, copy its link to their own existing agent and coworker.** This supersedes any proposed normal-path connector pairing approval, manual install, MCP configuration, key ceremony, homeserver selection, or separate Matrix registration elsewhere in this research. The agent handles supported connection/subscription setup itself after receiving the link. User-visible states can say “Waiting for your agent,” “Agent connected,” and “Messages awaiting review.”

Treat OAuth/account-to-agent binding and SDK device initialisation as implementation responsibilities to prove. Do not solve a missing runtime feature by assigning technical setup to the human or silently creating a different agent session. Exceptional recovery or unsupported-environment messages are distinct from the successful onboarding path.

## Source inventory and precedence

Links assume the repositories remain siblings of Khala.

| Source | What Khala should inherit |
|---|---|
| [Aiur marketing styles](../../../aiur/website/src/styles.css) and [page](../../../aiur/website/index.html) | Family palette, typography, logo lockup, restrained borders, prompt-copy control, product navigation, dark default |
| [Archon product home](../../../archon/site/index.html) | Existing example of extending the family to a sibling product, product-name wordmark, agent onboarding copy, account controls, decorative flow field |
| [Aiur dashboard styles](../../../aiur/src/priv/static/dashboard.css) | Dense application surfaces, semantic status colors, readable text hierarchy, accessible filled buttons, component radii and shadows |
| [Aiur documentation styles](../../../aiur/website/docs-app/.vitepress/theme/custom.css) | Docs treatment, brand headings, code blocks, independently tuned blue button fills |
| [Aiur brand tests](../../../aiur/website/tests/brand.spec.ts) | Theme persistence before hydration; contrast checks for muted text and button states |
| [Aiur dashboard theme tests](../../../aiur/src/test/aiur_web/dashboard_css_theme_test.exs) | Token consistency reference for an application rather than a marketing page |
| [Aiur theme bridge](../../../aiur/website/docs-app/.vitepress/theme/index.ts) | Mapping a docs framework's theme state to the family preference key |
| [Archon generic document theme](../../../archon/templates/base/theme.css) | Evidence of a separate customizable document theme; its red accent and gray surfaces do **not** define the Aiur brand |

The current source is duplicated across repositories rather than a shared brand package. Initial Khala work should vendor a small, attributed token and asset set with pinned source commits; extracting a cross-repository design system would expand scope and is not required to inherit the brand.

### Assets

The symbol is a cyan-to-blue crystal with an orbit, visually inspected from the existing PNG. These three files are byte-identical:

- [Archon symbol](../../../archon/site/assets/aiur-logo.png)
- [Aiur marketing symbol](../../../aiur/website/public/assets/aiur-logo.png)
- [Aiur application symbol](../../../aiur/src/priv/static/aiur-logo.png)

SHA-256: `5f3b8f3dfa3c1376c775ede482bbb2048bbc4a9c51fd4535ba826f0ec7ac7482`.

Preserve aspect ratio and the existing gradient. Pair a decorative image (`alt=""`) with an accessible text product name; provide an accessible name when the image is the entire home link. Reuse the existing favicon family from the selected sibling source, documenting source paths and checksums when copying. Do not silently rebrand the symbol as an individual agent avatar.

Aiur bundles [Bungee](../../../aiur/src/priv/static/bungee.woff2) for offline dashboard rendering. Marketing currently requests Bungee, Space Grotesk, and JetBrains Mono from Google Fonts. Proposed Khala application behavior is same-origin font delivery so opening a private room does not depend on a third-party font request. The implementation ticket must retain or obtain the appropriate font license files; this inspection did not find adjacent license files for all three fonts. Font packaging is an implementation prerequisite, not permission to replace the typefaces.

### Token mapping

For the marketing surface, copy these shared values from Aiur's marketing stylesheet:

| Role | Dark | Light |
|---|---|---|
| Page | `#1a1b1e` | `#e7d6b2` |
| Secondary page | `#161719` | `#e2cfa6` |
| Primary text | `#edeef0` | `#2a2520` |
| Muted text | `#8c8d93` | `#5f5645` |
| Accent | `#2f86ff` | `#1f57c4` |
| Dividers | `rgba(221,226,235,.14)` | `rgba(42,37,26,.17)` |

For conversation and review screens use the dashboard's application tokens, including its surface hierarchy and semantic ink/fill pairs. It intentionally has a darker root (`#16171a`), lighter muted dark text (`#969aa4`), sand cards (`#f4ecd9`), and application-specific muted light text (`#635a48`). This is an existing family variant, not a new palette. Its `--radius:16px`, `--radius-lg:24px`, and layered surfaces are useful starting values; do not apply a large card radius to every dense message row.

The dashboard explicitly distinguishes blue accent decoration from a blue button carrying white text. Dark `--accent-strong:#0070f0` and `--on-accent:#ffffff` are the relevant application pair. The docs use a different darker fill, `#1f6fcf`, with hover `#165eae`. Choose the application pair consistently for Khala controls and verify actual rendered contrast; copying only `--accent` into filled buttons loses a fix already made in Aiur. Similarly, use semantic `*-ink` colors on their intended surfaces, not raw status-fill colors as text.

### Theme and motion differences to resolve explicitly

Aiur marketing defaults to dark, persists `aiur-theme`, and applies it before hydration. Archon home follows `prefers-color-scheme` with a light bare root. Proposed Khala behavior follows Aiur: dark initial default, explicit light/dark toggle, stored choice applied before the first render. Handle unavailable storage without breaking the page. Identically named local-storage keys do not synchronize preferences between separate origins; do not imply a cross-product preference unless an actual mechanism is implemented.

The decorative diagonal flow field and letter entrance animation belong on a public landing surface if one ships. The chat/review surface should remain still while people read and decide. Preserve reduced-motion support; do not communicate queue progress through motion alone. Bungee fits product names and short page headings, Space Grotesk fits prose and controls, and JetBrains Mono fits code, IDs, timestamps, and technical metadata. Do not render an entire long conversation in monospace.

## Product experience proposed for review

The original [scope](recovered/SCOPE.md) requires at least two humans and their two agents, cross-owner invitations, queued previews before recipient-model delivery, and the option to relax the airlock. The later connector decision allows the connector itself to decrypt pending content. A four-actor demonstration is therefore the minimum meaningful end-to-end slice. A single-human chatbot screen would not prove the product.

### Room and attribution

The room header should identify the room and participating people, with each agent visually grouped under its owning human. Message headers should say, for example, **Morgan · Human** or **Build agent · Agent for Morgan**. Organization and model are secondary metadata, not authenticated identities by themselves. Agent delegation, signed authorship, human review, and verified device identity must remain separate concepts. A human approving a message does not become its author; a model name is not proof of a specific runtime.

Prefer a shared chronological conversation with explicit author headers over left/right chat bubbles whose direction implies that every remote message has the same author. Human posts, agent posts, and system events have different labels. Each recipient's review state is local to that recipient: a shared message can be released to one owner's agent while still awaiting another owner's review. Never show a room-wide “approved” badge when only one release exists.

Render external content as inert text/limited Markdown. Code fences and quotations remain visibly content, even if they contain strings such as “system,” “approved,” or “run this command.” No raw HTML, remote auto-loaded images, or executable previews in the initial review surface. Exact renderer and supported media are ticket decisions, with the same rules in the preview and the released-content view.

### Invitation and queued preview

Recommended flow for owner review:

1. A human creates a room, or their delegated agent prepares it with clear owner attribution.
2. The creator queues introductory messages and obtains an invitation for the other human.
3. Opening the invitation shows who invited the recipient and what access accepting grants. Validate the invitation before revealing protected room content.
4. The recipient joins as a human and reads the queued preview. Joining must not automatically pass pending messages into their agent model. Under the owner's connector-gated decision, a trusted connector may already be able to decrypt them.
5. The recipient shares the invitation link with their **existing agent session**. The link's machine-readable entry point explains how to attach that session through the supported connector. It carries no pending message bodies or human approval credential. If human authentication/device authorization is needed, it directs the human to the browser and then resumes the same join attempt. The recipient releases selected messages when ready; model-context delivery remains gated regardless of whether session attachment happens before or after preview.

The same shareable invitation URL can route humans and agents into the appropriate flow; separate credentials and authority do not require two different links or a mandatory onboarding wizard. A scoped agent handoff is an internal authorization operation, not a second product ceremony. Do not put a human bootstrap secret or review authority in the shareable URL. Notifications before acceptance should omit protected message bodies. Invitation-expired, invitation-revoked, wrong-account, device-not-authorized, and awaiting-key-access deserve distinct recovery paths rather than a generic empty room.

Proposed initial affordance: **Share this link with your agent** with a copy button, followed by status such as **Waiting for your agent**, **Agent connected; messages awaiting review**. Reuse available local tooling and installation state. Where a runtime needs one-time connector setup, the agent must perform supported setup itself. A required manual technical step is a compatibility gap against the settled user journey, not an assumed product prerequisite. Do not promise silent attachment to every runtime: the experiment must demonstrate how an already-running session discovers tools or another supported interface without losing its working context. A missing runtime capability should produce a precise compatibility explanation, not silently spawn a replacement agent.

### Review controls and trust

Use **Review** as the navigation label, with “airlock” explained in supporting copy if the owner wants to keep that term. On each item show author, owning human, intended recipient agent, immutable message version, and whether quoted context is included. A release decision must name the exact version and audience it affects.

Proposed controls are **Release to my agent**, **Keep for review**, and **Reject**. Redaction/annotation remains an explicit product question. If supported, show original versus released version and attribute the transformation to the reviewing human; never silently replace the author's original or imply that edited text is still their signed text. Bulk release and AI review summaries also require an explicit product decision because they change what the person actually reviews.

Trust controls should say **Review messages from Morgan before my agent receives them** and **Allow future messages from Morgan automatically in this room**. Keep the active policy visible in the room and composer context. Do not label the peer “Safe” or the content “Injection-free.” Re-enabling review affects future delivery; it cannot remove content already read or copied by an agent. Policy changes need a durable event, clear effective point, and a visible pending/confirmed distinction during connection loss. Exact policy scope and race semantics are owned by the identity/state research.

### Status language tied to evidence

| UI wording | Evidence required | Must not imply |
|---|---|---|
| Draft | Local unsent content | Server persistence |
| Sending | Submission in progress | Durable receipt |
| Sent | Durable service acknowledgement | Recipient read or model ingestion |
| Awaiting your review | Recipient has a pending review item | Model received it; connector cannot decrypt it |
| Released to your agent | Connector release decision confirmed for named agent and version | Model consumed it; previously encrypted from the connector |
| Delivered to agent connection | Adapter acknowledgement, if protocol supports it | Model read, understood, or acted |
| Agent responded | Attributed reply received | Correct or safe action |
| Reconnecting | Connection unavailable/recovering | Draft loss or automatic send failure |
| Syncing messages | Resume/replay active | Fully current state |
| History unavailable on this device | Missing historical key/access | Empty original room |

Avoid read receipts unless the protocol can define and support their exact meaning. Distinguish ciphertext receipt, decryption, adapter handoff, and model response. Do not derive trust-policy state from the last frame seen by the browser while replay is incomplete.

## Desktop, mobile, and accessibility acceptance intent

Desktop can show room navigation, conversation, and the review pane together. On phones use one main pane at a time with a persistent route to **Review (N)**; preserve selected item and reading position when switching. Keep the release action and recipient identity together, and account for the on-screen keyboard. Long code, URLs, names, and invitation errors must wrap or scroll inside their own region without widening the page.

The sibling [website operating notes](../../../aiur/website/AGENTS.md) document why a fixed-size headless screenshot is insufficient for mobile layout verification. Carry that lesson into Khala: exercise 360×780, 375×667, 390×844 and landscape 844×390 using actual mobile emulation, then inspect overflow and keyboard behavior. These are acceptance targets; no Khala application has yet been rendered or tested.

Required design acceptance checks: full keyboard operation; visible focus in both themes; accessible author/owner labels; dialogs restore focus; review updates do not steal focus; polite status announcements; status text in addition to color; legible controls and metadata on the exact surface used; reduced motion; zoom/reflow; touch targets that remain usable in the dense review queue. Expose useful connection/review changes through live regions without repeatedly announcing the entire transcript. A new remote message must not scroll a reader away from the message they are reviewing.

Avoid copying sibling accessibility defects simply because they are existing branding. The application token comments already document combinations where faint text is insufficiently legible. Brand inheritance includes the source's corrective choices, and actual composite backgrounds still require measurement.

## Proposed ticket slices for the root backlog

These are bounded candidates for sign-off, not approved detailed plans. Backend dependencies are listed so a UI ticket cannot falsely claim enforcement through presentation alone.

| Slice | Observable outcome | Dependency / boundary |
|---|---|---|
| Aiur brand foundation | Existing symbol, sourced tokens, bundled licensed fonts, light/dark first paint, accessible button/status primitives | No new logo; source manifest; no unrelated sibling changes |
| Room shell and attributed transcript | Two humans and two delegated agents can be distinguished in a readable responsive room | Authenticated membership and message projection contracts |
| Human invitation and queued preview | Recipient sees an authentic invitation and can read queued content before model delivery | Invite claim, human-device authorization, connector review boundary |
| Existing-session agent handoff | Human shares the invitation link with the agent already working; it attaches without a new session or exposed human approval credentials | Runtime discovery/setup, delegation/agent admission API and connector handshake |
| Per-recipient review queue | Exact message version can be kept, rejected, or released to a named agent, with confirmed outcome | Durable connector review/release API and concurrency contract |
| Visible trust policy | Human can change scoped future-message policy and see the confirmed effective state | Policy versioning, reconnect/replay and re-arming semantics |
| Recovery and connection states | Drafts, reconnect, missing keys, expired invitation and revoked access remain understandable | Authoritative replay/recovery/error contracts |
| Responsive and accessible product journey | Four-actor invite→preview→release→response flow usable across themes, mobile and keyboard | Vertical slice complete; include adversarial display content and long messages |
| Public product entry and onboarding copy | Khala reads as an Aiur product and explains the human/agent joining flow | Optional launch scope; landing page is separate from secure room rendering |

Each implementation plan should include representative signed/unsigned and pending/released fixtures, empty/error/reconnecting states, exact labels, component ownership, server prerequisites, prohibited shortcuts, and acceptance steps. Detailed `ce-brainstorm` / `ce-plan` work follows ticket sign-off as requested by the owner.

## Earlier product questions — candidates, not a required questionnaire

1. What should the first four-actor session accomplish: compare codebases, coordinate a joint implementation, debug an integration, or another concrete outcome? This determines whether text/code alone is enough.
2. Is the recipient reviewing only the initial queued introduction, every inbound cross-owner message by default, or a different boundary? Can each owner choose independently?
3. Should release support redaction/annotation initially, or only the exact original message? Should the sender know which messages were withheld?
4. When someone allows automatic delivery, is that permission limited to this room, or does it extend to the peer elsewhere? Should adding/replacing an agent re-enable review?
5. Is mobile intended for approving messages and reading updates, or for the complete creation/agent-connection workflow?
6. Are file attachments and links needed in the first useful session? Remote previews change both exposure and review design.
7. Does **Review** communicate the core control adequately, with **airlock** as explanatory language, or should **Airlock** be the product's primary term?

Brand identity itself is not reopened as a product question: the owner already specified that Khala inherits it from Aiur and Archon.

### Minimum product decisions to include in ticket sign-off

Reduce the earlier question list to three decisions that change the first useful vertical slice. Proposed defaults allow one coherent backlog to be reviewed; they remain unapproved until the owner signs off.

| Decision | Proposed default for the ticket proposal | Why it matters |
|---|---|---|
| What real collaboration proves the first release, and does it require attachments? | Two existing agents discuss a cross-repository technical task using text, code blocks and ordinary links; attachment/media work is a separately visible ticket | Determines the transcript and connector payload scope without assuming a new agent workflow |
| What is the initial review policy and release operation? | Each human reviews inbound cross-owner messages independently; release the exact message version; allow automatic future delivery from that peer in this room; edited versions require a new decision | Determines connector policy and the essential controls; redaction, bulk release and wider trust scope can be explicitly included or deferred |
| What must work on a phone in the first release? | Read, review/release and switch review policy; desktop is the reference for initial agent attachment, while a phone can still copy the same invitation link | Determines whether an Element-based integration's mobile limits are acceptable |

The human already specified existing-session/any-model attachment, OSS reuse, connector gating, Aiur brand inheritance, and hosting/language preferences. Do not re-ask those as scope choices. Which initial runtime adapters prove model independence is an engineering compatibility proposal backed by the experiment, not permission to narrow the product to a single model. UI wording such as **Review** versus **Airlock** can be proposed in the tickets rather than blocking architecture. Publication/license intent may still need a focused answer if the selected upstream combination makes it consequential; it need not stall the read-only comparison or become a general onboarding requirement.

## Matrix UI reuse addendum — after the owner's OSS and connector decisions

**Recommendation:** evaluate a thin Aiur-branded Element adaptation first, retaining its ordinary chat, account, device-verification, and recovery screens while adding Khala's ownership labels and a human-only review surface. Connector-gated review makes this substantially more plausible than the earlier separate-encryption-group design: Khala no longer needs a client that combines multiple cryptographic rooms into a fictional single timeline. This is an engineering recommendation, conditional on the bounded integration experiment below; no Element extension has been implemented or demonstrated here.

### Available reuse paths

| Path | Reuse and remaining work | Assessment |
|---|---|---|
| Configure Element and add a narrow Khala integration | Existing chat client; apply Aiur assets/theme, custom onboarding and review UI. Determine whether supported customisation points can expose ownership and review without patching the timeline | First experiment: largest immediate generic-chat reuse |
| Maintain a shallow Element fork | Same base, but explicit patch set for required Khala controls/rendering | Reasonable if changes stay small and upstream upgrades are repeatable; set a patch-maintenance acceptance gate |
| Custom Aiur UI on `matrix-js-sdk` | Reuse protocol client, crypto integration, sync and models, but build/select conversation UI, login/device/recovery journeys and their state handling | Fallback if Element extension seams cannot meet product behavior; materially more UI work, not an off-the-shelf chat UI |
| Embed Hydrogen UI/SDK | Existing embeddable timeline/view-model approach with mobile ambitions | Candidate only after compatibility and maintenance checks; upstream still describes incomplete readiness and its SDK documents unstable pre-1.0 APIs |
| Adapt Cinny | Existing alternative Matrix client | Whole-client fork candidate, not a generic drop-in component kit; compare only if Element's specific extension/layout constraints fail |
| Reuse Compound components | Existing React design-system primitives | Useful for ordinary controls if licensing and Aiur theming fit, but not a chat client, review engine, or encrypted-account recovery flow |

Element's official configuration supports an app name, themes, device display names, and branding-related options, but explicitly says it does not support complete private labeling through configuration alone. Therefore “change config and we are done” is not established. Its documented customisation points are relevant integration seams; their presence is not proof that timeline review actions or a human-only authority channel are supported. Inspect and pin the actual selected release before planning against them. Sources: [configuration](https://web-docs.element.dev/config.html), [customisations](https://web-docs.element.dev/customisations.html).

Do not plan on the historical `matrix-react-sdk` as a currently independent supported UI package: its repository was archived and merged into Element Web. Reusing those components now needs an explicit Element-source strategy rather than an assumed standalone SDK dependency. Source: [archived repository and migration notice](https://github.com/element-hq/matrix-react-sdk).

The JavaScript SDK supports browser and Node.js use and documents Rust-backed crypto initialization. That is valuable protocol/crypto reuse, but the SDK does not remove the need to implement a product's verification, recovery and review experience. Source: [Matrix JavaScript SDK](https://github.com/matrix-org/matrix-js-sdk/blob/develop/README.md).

Hydrogen explicitly targets isolated/embedded UI components and mobile browsers, but its README calls the client work in progress. Its SDK guide demonstrates mounting a timeline view and warns about API stability before 1.0. Validate current device verification, recovery, authentication, and security maintenance before treating a smaller bundle as a smaller ownership burden. Sources: [Hydrogen](https://github.com/element-hq/hydrogen-web), [SDK guide](https://github.com/element-hq/hydrogen-web/blob/master/doc/SDK.md).

### Inspected license identities and unresolved packaging decisions

These are upstream license observations as inspected on 2026-09-16, not a legal interpretation of Khala's eventual combination or deployment. Pin the chosen versions, record their license/notice files and bundled assets, then determine the resulting distribution/source-offer obligations for that concrete arrangement. Do not assume every Matrix project shares one license or that older Apache-licensed descriptions still apply.

| Component | Observed license declaration | Primary evidence |
|---|---|---|
| `matrix-js-sdk` | Apache License 2.0 | [LICENSE](https://github.com/matrix-org/matrix-js-sdk/blob/develop/LICENSE) |
| Element Web | README offers AGPL version 3 or later, GPL version 3 or later, or a separately agreed commercial license | [README](https://github.com/element-hq/element-web), [AGPL text](https://github.com/element-hq/element-web/blob/develop/LICENSE-AGPL-3.0), [commercial file](https://github.com/element-hq/element-web/blob/develop/LICENSE-COMMERCIAL) |
| Hydrogen | README offers AGPL version 3 or later or a separately agreed commercial license | [README](https://github.com/element-hq/hydrogen-web/blob/master/README.md), [AGPL text](https://github.com/element-hq/hydrogen-web/blob/master/LICENSE-AGPL-3.0) |
| Compound Web | README offers AGPL version 3 or later or a separately agreed commercial license | [README](https://github.com/element-hq/compound-web/blob/main/README.md), [AGPL text](https://github.com/element-hq/compound-web/blob/main/LICENSE-AGPL-3.0) |
| Cinny | Repository license file is GNU AGPL version 3; inspect file headers/package declaration before assigning an “or later” identifier | [LICENSE](https://github.com/cinnyapp/cinny/blob/dev/LICENSE), [repository](https://github.com/cinnyapp/cinny) |

Source availability is compatible with the user's OSS priority; no commercial license purchase is assumed. The owner still needs to settle Khala's own publication/license intent before a fork/component combination is selected. Keep code-license compliance separate from branding: identify which Element names, logos, notices and hosted-service references are configurable, which are embedded, and which have separate asset/trademark conditions. Existing Aiur branding is the requested user-facing identity; this does not authorize removal of required attribution. An exact audit of the pinned dependency tree and assets belongs in the reuse experiment's deliverable.

### Bounded experiment that chooses the UI path

Run the same four-actor scenario against stock Element with Aiur config plus the smallest available integration seam. Produce a local reviewable screen and a written patch/dependency inventory. Test these outcomes before choosing a fork or custom client:

1. A human accepts an invite and reads queued messages, then shares the same invitation link with an already-working agent session. The session attaches without restarting, switching models or requiring a separate Aiur installation. A separately identified connector can decrypt/sync the room while its model receives none of the pending content. Repeat with a second runtime/model combination and record actual tool-discovery limitations.
2. The human releases one exact message version. A model-facing tool cannot invoke approval or change review policy, including by sending text that resembles a control event.
3. Ownership labels survive ordinary rendering, reply previews, edits and reconnect. The human timeline remains legible without duplicating every released message.
4. Aiur fonts, symbol, palette, theme controls and attribution can be applied without overriding a broad set of unstable internal selectors.
5. Review remains usable at phone widths. Element's desktop support alone is not proof of Khala's required mobile journey; test the actual chosen client and review integration.
6. Device verification, missing-key errors, logout/relogin and history recovery continue to work without a parallel homegrown crypto store.
7. Repeat an upstream upgrade on the experiment and record which Khala changes conflict. Reject a “small integration” claim if it requires pervasive timeline/auth/crypto patches. Record whether the TypeScript client/extension can be built as the intended Netlify web artifact and which persistent services require a separate deployment such as Railway; do not expose this infrastructure split as extra user setup.

A separate review panel or web surface is acceptable if it shares the authenticated human experience and can enforce human-only authority. An embedded widget is only a candidate presentation mechanism: widget possession, room membership, or an ordinary room event must not by themselves authorize release. Prove its authentication/capability boundary, or use a direct authenticated human control surface. Do not send the human approval credential to the connector's model tools.

### Changes to the proposed UI tickets

- Add **UI reuse experiment and version/license inventory** ahead of application construction. Select one client path from observed results; do not build all candidates.
- Rewrite **Aiur brand foundation** as a token/asset adaptation of the selected client and the small Khala extension, preserving required notices. Start from config-supported theming before custom CSS patches.
- Rewrite **Room shell and attributed transcript** as ownership/agent attribution integration. Remove generic room list, composer and timeline reconstruction from the initial scope if Element supplies them.
- Keep **Invitation and queued preview**, but integrate existing Matrix account/device flows. No separate review encryption-room UI is required by the settled product decision.
- Keep **Agent connection**, **Review queue**, and **Trust policy** as Khala-specific work. Their durable state controls connector-to-model delivery; wording must disclose that the connector can already decrypt pending messages.
- Rewrite **Recovery and connection states** as reuse plus Khala-specific error/status integration. Do not implement a second sync loop or crypto recovery system merely to match the Aiur visual theme.
- Keep the four-actor mobile/accessibility journey. Existing client tests do not cover Khala's review authority or queue semantics; add tests at those new seams.

This changes the scope estimate: selecting Matrix plus an existing client removes much of the generic chat implementation, while leaving the distinctive human/agent ownership and release boundary as explicit Khala work. The license choice, extension fit, and mobile experience remain concrete selection gates rather than reasons to default prematurely to a bespoke client.
