# Khala detailed plans

53 tickets across nine epics. KHA-E09, the native agent surface, was added 2026-09-18 under decision P15 and is planned as one scope across `2026-09-18-kha-145-native-agent-surface-requirements.md` and `-plan.md`. These ce-brainstorm product contracts and ce-plan implementation plans describe work to execute; they do not claim implemented or tested product behavior.

`implementation-ready` means the plan is actionable once its dependencies and listed gates pass. `requirements-only` means a genuine product decision or prerequisite contract still prevents final commitment; candidate units remain documented.

[Scope and epics](../product/ticket-breakdown.md) · [Ownership](../product/repo-layout.md) · [Review reports](reviews/) · [Executor transition](../product/executor-transition.md)

| Ticket | Epic | Outcome | Plan readiness |
|---|---|---|---|
| [KHA-101](2026-09-16-kha-101-workspace-foundation-plan.md) | KHA-E02 | Scaffold TypeScript workspace and CI | implementation-ready |
| [KHA-102](2026-09-16-kha-102-backend-feasibility-plan.md) | KHA-E01 | Prove OSS backend hosting fit | implementation-ready |
| [KHA-103](2026-09-16-kha-103-claude-existing-session-proof.md) | KHA-E01 | Prove Claude existing-session attachment | implementation-ready |
| [KHA-104](2026-09-16-kha-104-codex-existing-session-proof.md) | KHA-E01 | Prove Codex existing-session attachment | implementation-ready |
| [KHA-105](2026-09-16-kha-105-messaging-identity-ports.md) | KHA-E02 | Define identity, channel and messaging ports | requirements-only |
| [KHA-106](2026-09-16-kha-106-delivery-harness-contracts.md) | KHA-E02 | Define approval and harness ports | requirements-only |
| [KHA-107](2026-09-16-kha-107-aiur-dashboard-shell.md) | KHA-E04 | Build Aiur-branded shell | implementation-ready |
| [KHA-108](2026-09-16-kha-108-messaging-deployment-plan.md) | KHA-E03 | Package messaging service deployment | implementation-ready |
| [KHA-109](2026-09-16-kha-109-backend-recovery-operations-plan.md) | KHA-E03 | Prove backend restore and upgrades | implementation-ready |
| [KHA-110](2026-09-16-kha-110-oauth-identity-mapping.md) | KHA-E04 | Implement OAuth identity mapping | requirements-only |
| [KHA-111](2026-09-16-kha-111-browser-device-lifecycle.md) | KHA-E04 | Implement browser encrypted device lifecycle | implementation-ready |
| [KHA-112](2026-09-16-kha-112-room-intro-commands.md) | KHA-E04 | Implement channel and intro commands | implementation-ready |
| [KHA-113](2026-09-16-kha-113-invitation-admission.md) | KHA-E04 | Implement invitation admission | requirements-only |
| [KHA-114](2026-09-16-kha-114-agent-link-bootstrap.md) | KHA-E05 | Implement agent-operated link bootstrap | requirements-only |
| [KHA-115](2026-09-16-kha-115-connector-durable-storage.md) | KHA-E05 | Persist connector keys and inbox | requirements-only |
| [KHA-116](2026-09-16-kha-116-encrypted-live-subscription.md) | KHA-E05 | Implement live encrypted subscription | requirements-only |
| [KHA-117](2026-09-16-kha-117-claude-harness-adapter.md) | KHA-E05 | Implement Claude harness adapter | requirements-only |
| [KHA-118](2026-09-16-kha-118-codex-harness-adapter.md) | KHA-E05 | Implement Codex harness adapter | requirements-only |
| [KHA-119](2026-09-16-kha-119-exact-approval-release.md) | KHA-E06 | Implement exact approval release | implementation-ready |
| [KHA-120](2026-09-16-kha-120-trust-rearm-transitions.md) | KHA-E06 | Implement trust and re-arm transitions | requirements-only |
| [KHA-121](2026-09-16-kha-121-bounded-model-dispatch.md) | KHA-E05 | Implement bounded model dispatch | requirements-only |
| [KHA-122](2026-09-16-kha-122-create-chat-composer.md) | KHA-E04 | Build create-channel and intro composer | implementation-ready |
| [KHA-123](2026-09-16-kha-123-attributed-live-timeline.md) | KHA-E04 | Build attributed live timeline | implementation-ready |
| [KHA-124](2026-09-16-kha-124-oauth-invitation-journey.md) | KHA-E04 | Build OAuth entry and invitation journey | implementation-ready |
| [KHA-125](2026-09-16-kha-125-recipient-review-ui.md) | KHA-E06 | Build recipient review UI | implementation-ready |
| [KHA-126](2026-09-16-kha-126-trust-agent-status.md) | KHA-E06 | Build trust and agent-status controls | requirements-only |
| [KHA-127](2026-09-16-kha-127-recovery-closure-ui.md) | KHA-E07 | Build recovery and closure UI | requirements-only |
| [KHA-128](2026-09-16-kha-128-device-agent-revocation.md) | KHA-E07 | Implement device and agent revocation | requirements-only |
| [KHA-129](2026-09-16-kha-129-encrypted-recovery.md) | KHA-E07 | Implement encrypted recovery | requirements-only |
| [KHA-130](2026-09-16-kha-130-connector-retention-cleanup.md) | KHA-E07 | Implement retention and local cleanup | requirements-only |
| [KHA-131](2026-09-16-kha-131-netlify-deployment-plan.md) | KHA-E03 | Package Netlify web and functions | implementation-ready |
| [KHA-132](2026-09-16-kha-132-human-flow-composition.md) | KHA-E04 | Wire real human create/share/channel flow | implementation-ready |
| [KHA-133](2026-09-16-kha-133-connector-runtime-composition.md) | KHA-E05 | Wire existing-session agent connection | requirements-only |
| [KHA-134](2026-09-16-kha-134-review-delivery-composition.md) | KHA-E06 | Wire human approval to model delivery | implementation-ready |
| [KHA-135](2026-09-16-kha-135-trust-controls-composition.md) | KHA-E06 | Wire trust, pause and status acknowledgments | requirements-only |
| [KHA-136](2026-09-16-kha-136-recovery-lifecycle-composition.md) | KHA-E07 | Wire recovery, revocation and cleanup | requirements-only |
| [KHA-137](2026-09-16-kha-137-multi-owner-acceptance-harness.md) | KHA-E08 | Build reusable multi-owner acceptance harness | implementation-ready |
| [KHA-138](2026-09-16-kha-138-security-boundary-proof.md) | KHA-E08 | Prove encryption and approval boundaries | implementation-ready |
| [KHA-139](2026-09-16-kha-139-collaboration-acceptance.md) | KHA-E08 | Prove collaborative task across owners | requirements-only |
| [KHA-140](2026-09-16-kha-140-root-acceptance-plan.md) | KHA-E08 | Close root with merged-product evidence | implementation-ready |
| [KHA-141](2026-09-16-kha-141-browser-crypto-proof.md) | KHA-E01 | Prove browser SDK crypto and UI seams | implementation-ready |
| [KHA-142](2026-09-16-kha-142-headless-crypto-proof.md) | KHA-E01 | Prove TypeScript headless crypto persistence | implementation-ready |
| [KHA-143](2026-09-16-kha-143-client-reuse-boundary.md) | KHA-E01 | Choose client reuse boundary | implementation-ready |
| [KHA-144](2026-09-16-kha-144-ownership-bootstrap-proof.md) | KHA-E01 | Prove OAuth-to-agent ownership bootstrap | requirements-only |
| [KHA-145](2026-09-18-kha-145-native-agent-surface-plan.md) | KHA-E09 | Prove the Claude native agent route | requirements-only |
| [KHA-146](2026-09-18-kha-145-native-agent-surface-plan.md) | KHA-E09 | Prove the Codex native CLI queue route | requirements-only |
| [KHA-147](2026-09-18-kha-145-native-agent-surface-plan.md) | KHA-E09 | Widen delivery contracts for native routes | requirements-only |
| [KHA-148](2026-09-18-kha-145-native-agent-surface-plan.md) | KHA-E09 | Build the Khala agent CLI | requirements-only |
| [KHA-149](2026-09-18-kha-145-native-agent-surface-plan.md) | KHA-E09 | Implement the Claude native route | requirements-only |
| [KHA-150](2026-09-18-kha-145-native-agent-surface-plan.md) | KHA-E09 | Implement the Codex native CLI route | requirements-only |
| [KHA-151](2026-09-18-kha-145-native-agent-surface-plan.md) | KHA-E09 | Build the Khala fallback skill | requirements-only |
| [KHA-152](2026-09-18-kha-145-native-agent-surface-plan.md) | KHA-E09 | Build the channel page and agent presence panel | requirements-only |
| [KHA-153](2026-09-18-kha-145-native-agent-surface-plan.md) | KHA-E09 | Compose the native agent surface | requirements-only |
