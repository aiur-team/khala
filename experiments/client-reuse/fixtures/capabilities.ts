export type CapabilityEvidence = {
  candidate: 'sdk-ui' | 'element-module';
  capability: string;
  result: 'supported' | 'requires-patch' | 'unsupported' | 'not-tested';
  sourceRevision: string;
  testPath: string | null;
  limitation: string | null;
};
const sdk = 'react@19.3.0 + matrix-js-sdk@42.4.0';
const element = 'f2e247684496637f80e73805442e7d8e99f68548 / module-api@2.1.0';
export const capabilities: CapabilityEvidence[] = [
  { candidate: 'sdk-ui', capability: 'content-only-mount', result: 'supported', sourceRevision: sdk, testPath: 'sdk/tests/dashboard.spec.ts', limitation: 'Synthetic presentation, not actual Aiur embedding' },
  { candidate: 'element-module', capability: 'content-only-mount', result: 'requires-patch', sourceRevision: element, testPath: 'element/check-upstream.mjs', limitation: 'LoggedInView retains SpacePanel and outer left wrapper; full Element host not launched' },
  { candidate: 'sdk-ui', capability: 'ordinary-oauth-return', result: 'not-tested', sourceRevision: sdk, testPath: 'sdk/src/App.test.tsx', limitation: 'Injected authentication fixture only; no OAuth provider or token exchange' },
  { candidate: 'element-module', capability: 'ordinary-oauth-return', result: 'not-tested', sourceRevision: element, testPath: null, limitation: 'overwriteAccountAuth and custom login hooks inspected; no provider lifecycle tested' },
  { candidate: 'sdk-ui', capability: 'browser-crypto-lifecycle', result: 'supported', sourceRevision: 'bbffce963f7218ad72e23f972703794a05161e8a', testPath: '../browser-crypto/tests/live.test.mjs', limitation: 'Inherited KHA-141 independent proof; this presentation creates no Matrix client' },
  { candidate: 'element-module', capability: 'browser-crypto-lifecycle', result: 'not-tested', sourceRevision: element, testPath: null, limitation: 'A Module API harness cannot prove Element host device lifecycle' },
  ...(['sdk-ui', 'element-module'] as const).map(candidate => ({ candidate, capability: 'synthetic-review-and-keyboard-mobile', result: 'supported' as const, sourceRevision: candidate === 'sdk-ui' ? sdk : element, testPath: candidate === 'sdk-ui' ? 'sdk/tests/dashboard.spec.ts' : 'element/tests/capabilities.spec.ts', limitation: 'Synthetic approval port, no human authority or model release proof' })),
];
const mandatory = ['content-only-mount', 'ordinary-oauth-return', 'browser-crypto-lifecycle', 'synthetic-review-and-keyboard-mobile'];
// Every row for a mandatory capability must be supported by a named test; one
// passing (possibly mocked) row cannot outvote a contradicting or untested row.
export function canSelectForProduction(candidate: CapabilityEvidence['candidate'], rows = capabilities) {
  return mandatory.every(capability => {
    const evidence = rows.filter(row => row.candidate === candidate && row.capability === capability);
    return evidence.length > 0 && evidence.every(row => row.result === 'supported' && row.testPath !== null);
  });
}
