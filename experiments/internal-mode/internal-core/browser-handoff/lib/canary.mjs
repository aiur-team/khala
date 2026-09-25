// A unique per-trial canary stands in for the launch credential. Every form the
// credential could take in process metadata is scanned for, so a leak is still
// detected if an opener percent-encodes or base64-encodes the URL it forwards.

import { randomBytes } from 'node:crypto';

export const REDACTED = '<CANARY>';

export function createCanary() {
  return `khalacanary${randomBytes(16).toString('hex')}`;
}

// Base64 of a longer string (a whole URL) encodes the canary differently for
// each of the three byte alignments it can start at, so each alignment gets a
// form: the characters mixed with neighbouring bytes are trimmed off both ends.
function base64Forms(canary) {
  const forms = [];
  for (let offset = 0; offset < 3; offset++) {
    const bytes = Buffer.concat([Buffer.alloc(offset), Buffer.from(canary)]);
    for (const encoding of ['base64', 'base64url']) {
      const text = bytes.toString(encoding).replace(/=+$/, '');
      const start = offset === 0 ? 0 : 4;
      forms.push(text.slice(start, text.length - 4));
    }
  }
  return forms;
}

export function leakForms(canary) {
  return [...new Set([canary, encodeURIComponent(canary), ...base64Forms(canary)])];
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
