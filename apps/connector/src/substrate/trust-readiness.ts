/** Wait for publication of the pinned Matrix key; a different key is never transient. */
export async function trustExactPeer(
  readFingerprint: () => Promise<string | null>,
  verify: () => Promise<void>,
  unverify: () => Promise<void>,
  expected: string,
  options: Readonly<{ attempts: number; intervalMs: number; pause?: (ms: number) => Promise<void> }> = {
    attempts: 30, intervalMs: 500,
  },
): Promise<void> {
  if (!expected || !Number.isSafeInteger(options.attempts) || options.attempts < 1
    || !Number.isSafeInteger(options.intervalMs) || options.intervalMs < 0) {
    throw new Error('matrix_trust_input_invalid');
  }
  const pause = options.pause ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let found = false;
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const observed = await readFingerprint();
    if (observed === expected) { found = true; break; }
    if (observed !== null) throw new Error('matrix_fingerprint_mismatch');
    if (attempt + 1 < options.attempts) await pause(options.intervalMs);
  }
  if (!found) throw new Error('matrix_device_key_missing');
  try {
    await verify();
    if (await readFingerprint() !== expected) throw new Error('matrix_fingerprint_mismatch');
  } catch (error) {
    try { await unverify(); }
    catch (rollbackError) { throw new Error('matrix_verification_rollback_failed', { cause: rollbackError }); }
    throw error;
  }
}
