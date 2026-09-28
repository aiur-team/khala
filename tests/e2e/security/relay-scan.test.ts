import { describe, expect, it } from 'vitest';
import { ChunkScanner, PostgresTarInventory, relayProbes, scanProbes } from './relay-scan';
import { mintCanary } from './fixtures';

function tarEntry(name: string, contents: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(contents.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.fill(32, 148, 156);
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return Buffer.concat([header, contents, Buffer.alloc((512 - contents.length % 512) % 512)]);
}

function pgArchive(relation = Buffer.from('relation')): Buffer {
  return Buffer.concat([
    tarEntry('data/PG_VERSION', Buffer.from('16\n')),
    tarEntry('data/base/16384/2619', relation),
    tarEntry('data/pg_wal/000000010000000000000001', Buffer.from('wal')),
    Buffer.alloc(1024),
  ]);
}

describe('relay evidence scanner', () => {
  it('finds decoded binary Megolm key bytes split across stream chunks', () => {
    const keyBytes = Buffer.from('0095ff3d26a189400107a0e274538fa1154777d499284ca386d947230dd09c8f', 'hex');
    const key = keyBytes.toString('base64');
    const probes = relayProbes([{ label: 'session-key-0', core: key, text: key }], [key]);
    const scanner = new ChunkScanner(probes, 'postgres-data-volume');
    scanner.write(Buffer.concat([Buffer.from('clean'), keyBytes.subarray(0, 11)]));
    scanner.write(Buffer.concat([keyBytes.subarray(11), Buffer.from('clean')]));
    expect(scanner.leaks).toContainEqual({ canary: 'session-key-0', encoding: 'raw-key', where: 'postgres-data-volume' });
    expect(scanProbes(Buffer.from('clean only'), probes, 'log')).toEqual([]);
  });

  it('finds a canary split across chunks and remains quiet on clean bytes', () => {
    const canary = mintCanary('relay');
    const probes = relayProbes([canary], []);
    const clean = new ChunkScanner(probes, 'database');
    clean.write(Buffer.from('unrelated'));
    expect(clean.leaks).toEqual([]);
    const injected = new ChunkScanner(probes, 'database');
    injected.write(Buffer.from(canary.core.slice(0, 5)));
    injected.write(Buffer.from(canary.core.slice(5)));
    expect(injected.leaks.some(leak => leak.canary === canary.label)).toBe(true);
  });

  it('requires complete PostgreSQL data entries in a chunked tar stream', () => {
    const archive = pgArchive();
    const inventory = new PostgresTarInventory();
    for (let offset = 0; offset < archive.length; offset += 137) inventory.write(archive.subarray(offset, offset + 137));
    expect(() => inventory.assertComplete()).not.toThrow();
    const truncated = new PostgresTarInventory();
    truncated.write(archive.subarray(0, archive.length - 512));
    expect(() => truncated.assertComplete()).toThrow('relay_database_archive_incomplete');
    const empty = new PostgresTarInventory();
    empty.write(Buffer.alloc(1024));
    expect(() => empty.assertComplete()).toThrow('relay_database_archive_missing_data');
  });

  it('detects an injected raw key in the physical archive while a clean archive stays clean', () => {
    const keyBytes = Buffer.from('91649d2adfb92c06cf0a6f234b29f6db50861e4e55f021eb06ca456ebbd171cc', 'hex');
    const probes = relayProbes([], [keyBytes.toString('base64')]);
    const clean = new ChunkScanner(probes, 'physical');
    clean.write(pgArchive());
    expect(clean.leaks).toEqual([]);
    const injected = new ChunkScanner(probes, 'physical');
    const archive = pgArchive(Buffer.concat([Buffer.from('before'), keyBytes, Buffer.from('after')]));
    for (let offset = 0; offset < archive.length; offset += 17) injected.write(archive.subarray(offset, offset + 17));
    expect(injected.leaks).toContainEqual({ canary: 'session-key-0', encoding: 'raw-key', where: 'physical' });
  });
});
