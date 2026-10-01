// Temporary bounded owner-review liveness trace. Never log room, binding,
// participant, preview, or message data. The salt changes on every page load.
const salt = crypto.getRandomValues(new Uint32Array(1))[0]!;
let total = 0;
let nextInstance = 0;
const counts = new Map<string, number>();

export function reviewTraceId(): number { return ++nextInstance; }

export function reviewTraceHash(identity: string): string {
  let hash = (2166136261 ^ salt) >>> 0;
  for (let index = 0; index < identity.length; index += 1) {
    hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function reviewTrace(phase: string, instance: number, identity?: string): void {
  if (total >= 80) return;
  total += 1;
  const count = (counts.get(phase) ?? 0) + 1;
  counts.set(phase, count);
  console.info('khala.review.trace', { phase, instance, count,
    ...(identity === undefined ? {} : { identityHash: reviewTraceHash(identity) }) });
}
