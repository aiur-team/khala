export const DECRYPTION_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export type DecryptionRetry = { id: string; firstSeen: number };
export function retryUnexpired(entry: DecryptionRetry, now = Date.now()): boolean {
  return now - entry.firstSeen <= DECRYPTION_RETRY_MAX_AGE_MS;
}
