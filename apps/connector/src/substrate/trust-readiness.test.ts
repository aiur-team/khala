import { describe, expect, it, vi } from 'vitest';
import { trustExactPeer } from './trust-readiness';

describe('connector Matrix peer trust', () => {
  it('waits for the exact published device key before verifying it', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue('expected');
    const verify = vi.fn(async () => undefined);
    const pause = vi.fn(async () => undefined);
    await trustExactPeer(read, verify, 'expected', { attempts: 3, intervalMs: 0, pause });
    expect(read).toHaveBeenCalledTimes(4);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('never verifies a different or permanently absent key', async () => {
    const verify = vi.fn(async () => undefined);
    const pause = vi.fn(async () => undefined);
    await expect(trustExactPeer(async () => 'different', verify, 'expected',
      { attempts: 3, intervalMs: 0, pause })).rejects.toThrow('matrix_fingerprint_mismatch');
    expect(pause).not.toHaveBeenCalled();
    await expect(trustExactPeer(async () => null, verify, 'expected',
      { attempts: 3, intervalMs: 0, pause })).rejects.toThrow('matrix_device_key_missing');
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects a key changed during verification', async () => {
    const read = vi.fn().mockResolvedValueOnce('expected').mockResolvedValueOnce('different');
    const verify = vi.fn(async () => undefined);
    await expect(trustExactPeer(read, verify, 'expected')).rejects.toThrow('matrix_fingerprint_mismatch');
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
