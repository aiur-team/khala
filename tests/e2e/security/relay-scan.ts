import { type Canary, type Leak, leakForms } from './fixtures';

export type Probe = Readonly<{ label: string; encoding: string; needle: Buffer }>;

/** The SDK exports text keys, but a relay could persist their decoded bytes. */
export function relayProbes(canaries: readonly Canary[], sessionKeys: readonly string[]): Probe[] {
  const probes = canaries.flatMap(canary => leakForms(canary).map(form => ({
    label: canary.label, encoding: form.encoding, needle: form.needle,
  })));
  sessionKeys.forEach((key, index) => {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(key)) throw new Error('relay_session_key_encoding_invalid');
    const decoded = Buffer.from(key, 'base64url');
    if (decoded.length < 32 || decoded.toString('base64url') !== key.replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_')) {
      throw new Error('relay_session_key_encoding_invalid');
    }
    probes.push({ label: `session-key-${index}`, encoding: 'raw-key', needle: decoded });
  });
  return probes;
}

export function scanProbes(bytes: Uint8Array, probes: readonly Probe[], where: string): Leak[] {
  const haystack = Buffer.from(bytes);
  return probes.filter(probe => haystack.includes(probe.needle))
    .map(probe => ({ canary: probe.label, encoding: probe.encoding, where }));
}

/** Scans arbitrary chunk boundaries without retaining database contents. */
export class ChunkScanner {
  private tail = Buffer.alloc(0);
  private readonly keep: number;
  readonly leaks: Leak[] = [];
  bytes = 0;

  constructor(private readonly probes: readonly Probe[], private readonly where: string) {
    this.keep = Math.max(0, ...probes.map(probe => probe.needle.length - 1));
  }

  write(part: Uint8Array): void {
    const chunk = Buffer.from(part);
    this.bytes += chunk.length;
    const window = Buffer.concat([this.tail, chunk]);
    this.leaks.push(...scanProbes(window, this.probes, this.where));
    this.tail = window.subarray(Math.max(0, window.length - this.keep));
  }
}

/** Minimal tar inventory: refuses truncated/malformed Docker copies and records PG data entries. */
export class PostgresTarInventory {
  private pending = Buffer.alloc(0);
  private remaining = 0;
  private ended = false;
  private zeroBlocks = 0;
  readonly entries = new Set<string>();

  write(part: Uint8Array): void {
    if (this.ended) {
      if (Buffer.from(part).some(byte => byte !== 0)) throw new Error('relay_database_archive_invalid');
      return;
    }
    this.pending = Buffer.concat([this.pending, Buffer.from(part)]);
    while (true) {
      if (this.remaining > 0) {
        const used = Math.min(this.remaining, this.pending.length);
        this.pending = this.pending.subarray(used);
        this.remaining -= used;
        if (this.remaining > 0) return;
      }
      if (this.pending.length < 512) return;
      const header = this.pending.subarray(0, 512);
      this.pending = this.pending.subarray(512);
      if (header.every(byte => byte === 0)) {
        this.zeroBlocks += 1;
        if (this.zeroBlocks === 2) {
          this.ended = true;
          if (this.pending.some(byte => byte !== 0)) throw new Error('relay_database_archive_invalid');
          return;
        }
        continue;
      }
      if (this.zeroBlocks !== 0) throw new Error('relay_database_archive_invalid');
      const rawName = header.subarray(0, 100).toString('utf8').split('\0', 1)[0]!;
      const prefix = header.subarray(345, 500).toString('utf8').split('\0', 1)[0]!;
      const name = [prefix, rawName].filter(Boolean).join('/').replace(/^\.\//u, '');
      const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
      if (!name || !/^[0-7]+$/u.test(sizeText)) throw new Error('relay_database_archive_invalid');
      const size = Number.parseInt(sizeText, 8);
      if (!Number.isSafeInteger(size) || size > 1024 * 1024 * 1024) throw new Error('relay_database_archive_invalid');
      this.entries.add(name);
      this.remaining = Math.ceil(size / 512) * 512;
    }
  }

  assertComplete(): void {
    if (!this.ended || this.remaining !== 0 || this.pending.some(byte => byte !== 0)) {
      throw new Error('relay_database_archive_incomplete');
    }
    const names = [...this.entries];
    if (!names.some(name => /(?:^|\/)PG_VERSION$/u.test(name))
      || !names.some(name => /(?:^|\/)base\/[0-9]+\/[0-9]+(?:\.[0-9]+)?$/u.test(name))
      || !names.some(name => /(?:^|\/)pg_wal\/[A-F0-9]{24}$/u.test(name))) {
      throw new Error('relay_database_archive_missing_data');
    }
  }
}
