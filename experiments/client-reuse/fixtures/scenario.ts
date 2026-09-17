// Synthetic presentation-only fixture, not a replacement for KHA-105/106 contracts.
export type Batch = Readonly<{ eventIds: readonly string[]; digest: string; policyGeneration: number; bindingGeneration: number }>;
export const batch: Batch = Object.freeze({ eventIds: Object.freeze(['$fixture-human']), digest: 'fixture-digest-v1', policyGeneration: 3, bindingGeneration: 7 });
export const messages = [
  { id: '$fixture-human', author: 'Alex · human', text: 'Please review this plan before your agent sees it.', available: true },
  { id: '$fixture-agent', author: 'Sam’s agent · agent', text: 'Synthetic proposal: ' + 'long-content-'.repeat(70), available: true },
  { id: '$fixture-locked', author: 'Sam · human', text: 'Encrypted message unavailable on this device', available: false },
];
export type ReviewPort = { approve(value: Batch): Promise<'unknown' | 'acknowledged'> };
export function fixtureReviewPort(): ReviewPort {
  return { async approve(value) {
    if (JSON.stringify(value) !== JSON.stringify(batch)) throw new Error('Review selection changed');
    return 'unknown';
  } };
}
export function deliveryLabel(value: 'unknown' | 'acknowledged' | 'pending') {
  return value === 'unknown' ? 'Delivery unknown — check status before retrying' : value === 'acknowledged' ? 'Connector acknowledged — model consumption unconfirmed' : 'Awaiting human review';
}
