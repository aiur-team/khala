# KHA-143 client reuse boundary evidence

Observed 2026-09-17. Recommend **thin React presentation around the existing SDK
lifecycle**, preserving the Aiur host/content split. **Production selection remains
blocked by untested ordinary OAuth/account admission**, and the Element candidate
also lacks full-host crypto/embedding proof. This is a completed bounded comparison,
not permission to mark mocked integration as passed or dispatch production UI as if
all mandatory flows were verified. `fixtures/capabilities.ts` and its test encode
that unresolved mandatory evidence prevents selection for either candidate.

## Actual probes and versions

Both isolated installs, builds, unit suites and Chromium suites passed. React and
ReactDOM 19.3.0, TypeScript 5.9.3, Vite 7.1.12, Playwright 1.55.1; SDK candidate pins
matrix-js-sdk 42.4.0, matching [KHA-141](browser-crypto.md). Element candidate pins
`@element-hq/element-web-module-api` 2.1.0 and 2.0.0 under an alias for loader upgrade
replay. Browser: Chromium 150.0.7871.128. Reproduction commands and screenshots are
in [the experiment](../../experiments/client-reuse/README.md). No real credentials
or participant data appear in captures.

The SDK UI creates no MatrixClient, opens no crypto store and sends no real approval.
Its `ClientLease` is a type-only example of dependency injection, not a new canonical
contract. Real SDK event observation, crypto restart and trusted peer proof remain
in KHA-141. The Element harness uses the *real published loader* and real declared hook
types, but substitutes the host callbacks. Its timeline is visibly labeled synthetic.
It is not a full Element client build, Element browser crypto test, or SSO login test.

| Capability, same synthetic scenario | Thin SDK presentation | Element module candidate |
| --- | --- | --- |
| Content mount without duplicate navigation | Browser tested (`?embedded=1`) | Requires private host patch; source evidence below |
| Desktop / narrow layout, long attributed human/agent messages | Browser tested at 1440×1000 and 390×844 | Same fixture browser tested; actual Element layout not tested |
| Light/dark and collapsed rail | Browser tested using Aiur-derived tokens | Harness uses shared fixture styles; Element host theme not tested |
| Invitation authentication return | Injected fixture returns invitation; live OAuth **not tested** | Navigation callback recorded; live OAuth **not tested** |
| Encrypted-unavailable message | Explicit synthetic placeholder | Same synthetic placeholder |
| Selected human review preserves digest/generations | Fixture rejects changed binding/digest; presentation only | Same fixture and public module route callback; presentation only |
| Unknown delivery | Explicit unknown, no automatic retry, no claim of model consumption | Same browser assertion |
| Keyboard dialog open/Escape/focus return | Browser passed | Harness browser passed |
| Device lifecycle | Separate real141 SDK proof inherited | Full Element host **not tested** |
| Module failure | Not applicable | Actual incompatible loader rejection; browser displays missing review controls |

Unit results: SDK 4 tests; Element 4 tests. Each candidate has one browser test with
all applicable assertions; no skipped tests. These are functional keyboard checks,
not an exhaustive accessibility audit. The module fixture's client-side callbacks
cannot establish human-only authority; future composition must bind approved
server/connector ports and must not expose release as an agent tool.

## Pinned extension and private patch evidence

Source revision: Element
[`f2e247684496637f80e73805442e7d8e99f68548`](https://github.com/element-hq/element-web/tree/f2e247684496637f80e73805442e7d8e99f68548).
The matching source package declares Module API 2.1.0. Source-check hashes and exact
paths are saved in `element/source-evidence.json`; source checks are not runtime
acceptance.

- [`navigation.registerLocationRenderer`](https://github.com/element-hq/element-web/blob/f2e247684496637f80e73805442e7d8e99f68548/packages/module-api/src/api/navigation.ts) exposes an **alpha** route renderer; `openRoom` is the exposed join/navigation hook.
- [`builtins.renderRoomView`](https://github.com/element-hq/element-web/blob/f2e247684496637f80e73805442e7d8e99f68548/packages/module-api/src/api/builtins.ts) and RoomViewProps hide room header/composer/right panel/widgets; these are **alpha** surfaces, not a stable external component kit.
- [`LoggedInView.tsx:653–723`](https://github.com/element-hq/element-web/blob/f2e247684496637f80e73805442e7d8e99f68548/apps/web/src/components/structures/LoggedInView.tsx#L653) invokes module content and hides its room list, but retains SpacePanel and a left wrapper. Exposed UIComponent customization has no host-shell suppression option. Branding alone does not remove this chrome.
- The published `Api.overwriteAccountAuth` and custom login props allow account injection in principle; actual OAuth provisioning, invitation admission, token refresh and user device setup are **not exercised** by this comparison.

[PATCHES.md](../../experiments/client-reuse/element/PATCHES.md) records a proposed
2-statement private JSX change at one host site. It is explicitly untested, not a
working patch or a complete estimate. Full-host CSS, login/calls/toast layout and
upgrade regressions remain additional ownership. No deprecated matrix-react-sdk
component override or private component import was smuggled into the probe.

Identical fixture module loaded on the **actual** 2.0.0 and 2.1.0 engines; incompatible
major version rejects. This is a minor-version replay, not full-host upgrade proof.
Registry snapshot had no 2.1.x patch release to replay. No alpha stability guarantee
is inferred.

## Dashboard fit and ownership cost

Read-only Aiur reference: revision `5c701a82e909f767bd52bfeef4b3547aaab1b192`,
`src/priv/static/dashboard.css` and dashboard shell conventions from the planning
grounding. Fixture reproduces semantic dark/sepia colors, 16px panels, 24px dialogs,
15rem navigation, 75rem measure and 960px responsive breakpoint. No Aiur process,
configuration, routes, assets or authentication was changed. Logos/fonts were not
copied; the text identity is synthetic comparison chrome.

Built fixture assets: SDK JS 227,528 bytes plus CSS 2,190 bytes; Element harness
JS 253,898 bytes plus the same CSS. **Not comparable production client sizes**:
the SDK's crypto is type-only in this UI bundle, and the Element host is absent.
KHA-141 separately reports the real 7.83 MB WASM asset. No claim that this probe
eliminates that transport/crypto bundle. Local presentation stays small and owns
only layout, selection, status and dialogs; a real timeline must use the proven SDK
projection/pagination lifecycle instead of rebuilding transport or crypto.

## Provenance and license inventory

Both candidate directories contain `license-inventory.json`: installed dependency
names/versions, declared licenses and available LICENSE/COPYING/NOTICE hashes,
including build-only/transitive dependencies. A missing standalone license file or
metadata-only record requires release notice review; these inventories are not a
legal conclusion or distributable notice bundle.

- React/ReactDOM 19.3.0: inspected installed MIT LICENSE; [exact React package](https://registry.npmjs.org/react/19.3.0).
- MatrixJS 42.4.0: installed Apache-2.0 LICENSE and [pinned source license](https://github.com/matrix-org/matrix-js-sdk/blob/bbffce963f7218ad72e23f972703794a05161e8a/LICENSE).
- Vite 7.1.12: installed LICENSE.md covers MIT core and bundled third-party notices; [exact package](https://registry.npmjs.org/vite/7.1.12).
- Module API 2.1.0: [inspected revision README](https://github.com/element-hq/element-web/blob/f2e247684496637f80e73805442e7d8e99f68548/packages/module-api/README.md) says AGPL-3.0-or-later or commercial. Do **not** infer the full Element GPL option applies to this separately packaged API.
- Full Element: [revision README](https://github.com/element-hq/element-web/blob/f2e247684496637f80e73805442e7d8e99f68548/README.md) identifies AGPL/GPL/commercial alternatives; inspected LICENSE-AGPL-3.0, LICENSE-GPL-3.0 and LICENSE-COMMERCIAL paths exist. No branding/trademark permissions inferred.
- Aiur's local LICENSE is Apache-2.0; this fixture uses observed numerical design tokens and independently written JSX/CSS. No Compound/Hydrogen components or external font assets included.

Lock SHA256: SDK `f19c86daa7b0a37c51cf66496407abe2036253c5f127f3ff2c9bbb4c1d7fc364`;
Element `4a73f483564d863f6e45797e857ccb5bb5c51ac4128f2b510c8c05e9bea383d6`.

## Handoff and remaining selection gate

Recommend React 19.3.0/ReactDOM 19.3.0 with the existing MatrixJS 42.4.0 device lifecycle
for the content boundary. The likely KHA-107 export is a content-only component taking
projected data and injected ports; standalone shell lives outside it. KHA-132 should own
one lease-managed client, authentication/invitation composition and canonical
KHA-105/106 adapters. This experiment defines no competing protocol and changes no
root manifest or production route.

To convert the recommendation into production selection, verify the ordinary
OAuth/admission return through the selected authenticated control path with no
homeserver/key setup presented to users. Element additionally needs a full-host
embedding/crypto run or should remain rejected for the current dashboard boundary.
These are explicit missing proofs, not green mocks. No new messaging backend or
production renderer has been silently selected.
