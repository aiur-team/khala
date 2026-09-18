// Explicit fixture-only subpath: `@khala/contracts/delivery/fixtures`.
// Production code imports `delivery/index`; conformance consumers resolve these
// URLs and load the literal JSON suites. URL handles avoid making fixtures part of
// the production module graph while preserving one canonical copy on disk.

export const deliveryFixtureUrls = Object.freeze({
  approval: new URL('../../fixtures/delivery/approval.json', import.meta.url),
  capabilities: new URL('../../fixtures/delivery/capabilities.json', import.meta.url),
  exactRelease: new URL('../../fixtures/delivery/exact-release.json', import.meta.url),
});
