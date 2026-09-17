# Element host adaptation boundary

Pinned Element source: `f2e247684496637f80e73805442e7d8e99f68548`; shipped Module API 2.1.0.
No upstream source was patched or forked for this experiment. `check-upstream.mjs`
checks the exact source locations and records hashes in `source-evidence.json`.

Supported exposed hooks actually consumed by the harness:

- `ModuleLoader.load/start` and `Module.moduleApiVersion`: public runtime loader.
- `navigation.registerLocationRenderer`: **alpha** route renderer.
- `navigation.openRoom({autoJoin:true})`: public navigation; host callback is simulated.
- `builtins.renderRoomView` and `RoomViewProps.hideHeader/hideRightPanel/hideWidgets`: **alpha**; host room rendering is simulated.

`LoggedInView.tsx:653–658` invokes registered renderers, and lines 683–687 hide the
room list for a module renderer. Lines 721–723 still render the SpacePanel and outer
left-panel wrapper around custom route content. `UIComponent` exposes no SpacePanel
or top-level shell entry, and RoomViewProps only suppress room-local chrome.
`rootNode` is documented for sibling React trees, not replacing the Element host.

Minimal *proposed, untested* private patch to the exact module fallback branch:

```diff
--- a/apps/web/src/components/structures/LoggedInView.tsx
+++ b/apps/web/src/components/structures/LoggedInView.tsx
@@
-                    <SpacePanel />
-                    {leftPanel}
+                    {!moduleRenderer && <SpacePanel />}
+                    {!moduleRenderer && leftPanel}
                     {roomView}
```

This is two changed JSX statements at one private host site. It is only a lower
bound: inherited layout CSS, toasts, calls, login, and responsive behavior must be
built and exercised in the full Element application. The patch is not represented
as working, and a module cannot apply it through the exposed API. A production
adaptation would own that fork/rebase plus any discovered CSS/auth changes. Branding
config alone does not solve host/content separation.

The *actual shipped loader* was replayed from 2.0.0 to 2.1.0 using the identical
module and synthetic host. Both register the route; a deliberately incompatible
major rejects and the browser shows unavailable review controls. This is a **minor**
upgrade, not a patch release; no 2.1.x patch release was published in the registry
snapshot. Full Element host upgrades were not tested. Tests do not assert that alpha
hooks are stable merely because one loader replay passed.
