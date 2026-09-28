/** Wait only for publication of the exact device. A different key is never transient. */
export async function waitForExactDeviceFingerprint(
  read: () => Promise<string | null>, expected: string,
  options: Readonly<{ attempts: number; intervalMs: number; pause?: (ms: number) => Promise<void> }> = {
    attempts: 30, intervalMs: 500,
  },
): Promise<void> {
  if (!expected || !Number.isSafeInteger(options.attempts) || options.attempts < 1
    || !Number.isSafeInteger(options.intervalMs) || options.intervalMs < 0) {
    throw new Error('device_fingerprint_wait_invalid');
  }
  const pause = options.pause ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const observed = await read();
    if (observed === expected) return;
    if (observed !== null) throw new Error('out-of-band fingerprint mismatch');
    if (attempt + 1 < options.attempts) await pause(options.intervalMs);
  }
  throw new Error('out-of-band fingerprint missing');
}

/** Pin the same key on both sides of the SDK verification call. */
export async function trustExactDeviceFingerprint(
  read: () => Promise<string | null>, verify: () => Promise<unknown>, expected: string,
): Promise<void> {
  await waitForExactDeviceFingerprint(read, expected);
  await verify();
  if (await read() !== expected) throw new Error('out-of-band fingerprint mismatch');
}
