import { randomBytes } from 'node:crypto';

export const CODEX_IDLE_WAKE_NOTICE = 'Khala: channel messages are waiting. Continue.';
export const WAKE_RETRY_MS = 60_000;
export const MAX_WAKES_PER_DELIVERY = 2;
export function newNonce(): string { return randomBytes(4).toString('hex'); }
export function wakeLine(nonce: string): string {
  if (!/^[a-f0-9]{8}$/.test(nonce)) throw new Error('invalid_wake_nonce');
  return `${CODEX_IDLE_WAKE_NOTICE} (k-${nonce})`;
}
