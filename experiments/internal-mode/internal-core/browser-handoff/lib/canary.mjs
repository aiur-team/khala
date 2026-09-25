// A unique per-trial canary stands in for the launch credential. Every form the
// credential could take in process metadata is scanned for, so a leak is still
// detected if an opener percent-encodes or base64-encodes the URL it forwards.

import { randomBytes } from 'node:crypto';

export const REDACTED = '<CANARY>';

export function createCanary() {
  return `khalacanary${randomBytes(16).toString('hex')}`;
}

export function leakForms(canary) {
  return [...new Set([
    canary,
    encodeURIComponent(canary),
    Buffer.from(canary).toString('base64').replace(/=+$/, ''),
    Buffer.from(canary).toString('base64url'),
  ])];
}

export function containsLeak(text, forms) {
  return forms.some(form => text.includes(form));
}

export function redact(text, forms) {
  let out = text;
  for (const form of forms) out = out.split(form).join(REDACTED);
  return out;
}

export function bootstrapUrl({ origin, canary, channelId }) {
  return `${origin}/__khala/bootstrap#credential=${canary}&channel=${channelId}`;
}
