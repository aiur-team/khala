/**
 * Published-package facts. `scripts/build-package.mjs` defines `__KHALA_BUNDLE__` when it
 * bundles the CLI into `npm/dist`; under tsx (checkout and tests) it is undefined.
 */
declare const __KHALA_BUNDLE__: { name: string; version: string } | undefined;
export const bundle: { name: string; version: string } | undefined =
  typeof __KHALA_BUNDLE__ === 'undefined' ? undefined : __KHALA_BUNDLE__;
