import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openChannelStore } from '../store/open';
import { SECRET_CANARIES, directoryFor, makeRoot, seedChannel, tree } from './fixtures/channel';
import { type ExportFormat, type ExportOverwrite, exportInternalChannel } from './export';

const roots: string[] = [];
const handles: Array<{ close(): void }> = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const HOSTILE_BODY = [
  '# Injected heading',
  '',
  '```',
  '## Injected inside a fence',
  '````js',
  'nested();',
  '````',
  '```',
  '',
  '> quoted',
  '- list item',
  '1. ordered',
  '<script>alert(1)</script>',
  '~~~',
  '### Message 99',
  '    indented',
  '',
  '',
].join('\n');

function outputDirectory(): string {
  const directory = fs.mkdtempSync(path.join('/tmp', 'khala-export-out-'));
  roots.push(directory);
  return directory;
}

function run(
  root: string,
  destination: string,
  format: ExportFormat,
  overwrite: ExportOverwrite = 'refuse',
  fault?: Parameters<typeof exportInternalChannel>[0]['fault'],
) {
  return exportInternalChannel({ root, channelId: 'channel-one', format, destination, overwrite, ...(fault ? { fault } : {}) });
}

type Block = Readonly<{ info: string; lines: string[] }>;

/**
 * Minimal CommonMark block scan: fenced code opens with 3+ backticks or tildes
 * and closes only on a same-character run at least as long with no info string.
 * Returns the headings rendered outside fences and every fenced block.
 */
function markdownStructure(markdown: string): Readonly<{ headings: string[]; blocks: Block[] }> {
  const headings: string[] = [];
  const blocks: Block[] = [];
  let open: Readonly<{ char: string; length: number; block: Block }> | null = null;
  for (const line of markdown.split('\n')) {
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close?.[1] && close[1][0] === open.char && close[1].length >= open.length) {
        open = null;
      } else {
        open.block.lines.push(line);
      }
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence?.[1]) {
      const block = { info: fence[2]?.trim() ?? '', lines: [] };
      blocks.push(block);
      open = { char: fence[1][0] ?? '`', length: fence[1].length, block };
      continue;
    }
    if (/^ {0,3}#{1,6}(\s|$)/.test(line)) headings.push(line.trim());
    if (/^ {0,3}(>|<[a-z])/i.test(line)) headings.push(`STRUCTURE:${line}`);
  }
  return { headings, blocks };
}

describe('exportInternalChannel', () => {
  it('keeps authored headings, fences and newlines as literal message content (wrong-implementation test)', () => {
    const root = makeRoot(roots);
    seedChannel(root, 'channel-one', [
      { author: 'alice', body: HOSTILE_BODY },
      { author: 'bob', body: 'plain `code` and ``double``' },
    ], { title: '# Title heading\n```' });
    const destination = path.join(outputDirectory(), 'channel.md');
    expect(run(root, destination, 'markdown')).toMatchObject({ kind: 'exported', format: 'markdown' });
    const markdown = fs.readFileSync(destination, 'utf8');
    const structure = markdownStructure(markdown);
    expect(structure.headings).toEqual([
      '# Khala internal channel export',
      '## Participants',
      '## Messages',
      '### Message 1',
      '### Message 2',
    ]);
    expect(structure.blocks.map(block => block.info)).toEqual(['text', 'text']);
    expect(structure.blocks.map(block => block.lines.join('\n'))).toEqual([HOSTILE_BODY, 'plain `code` and ``double``']);
    expect(markdown).toContain('- Title: ```` "# Title heading\\n```" ````');
  });

  it('writes byte-identical Markdown and JSONL for unchanged state across restart', () => {
    const root = makeRoot(roots);
    seedChannel(root, 'channel-one', [{ author: 'alice', body: 'one' }, { author: 'bob', body: 'two\nlines' }]);
    const out = outputDirectory();
    for (const format of ['markdown', 'jsonl'] as const) {
      expect(run(root, path.join(out, `a.${format}`), format).kind).toBe('exported');
      const handle = openChannelStore({ directory: directoryFor(root, 'channel-one'), mode: 'existing' });
      handle.close();
      expect(run(root, path.join(out, `b.${format}`), format).kind).toBe('exported');
      expect(fs.readFileSync(path.join(out, `a.${format}`))).toEqual(fs.readFileSync(path.join(out, `b.${format}`)));
      expect(fs.statSync(path.join(out, `a.${format}`)).mode & 0o777).toBe(0o600);
    }
  });

  it('emits versioned JSONL records in fixed order that round-trip canonical bodies and authorship', () => {
    const root = makeRoot(roots);
    seedChannel(root, 'channel-one', [
      { author: 'bob', body: HOSTILE_BODY },
      { author: 'alice', body: '' },
      { author: 'bob', body: '\u{1F600} ‮' },
    ]);
    const destination = path.join(outputDirectory(), 'channel.jsonl');
    expect(run(root, destination, 'jsonl')).toMatchObject({ kind: 'exported', format: 'jsonl' });
    const text = fs.readFileSync(destination, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    const records = text.slice(0, -1).split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(records.map(record => record['record'])).toEqual([
      'export', 'channel', 'participant', 'participant', 'message', 'message', 'message',
    ]);
    expect(records.every(record => record['v'] === 1)).toBe(true);
    expect(records[0]).toEqual({ record: 'export', v: 1, format: 'khala.internal.export.jsonl.v1' });
    expect(records[1]).toEqual({
      record: 'channel', v: 1, channelId: 'channel-one', title: 'Fixture channel', createdAt: '2026-09-24T20:00:00.000Z',
      creatorParticipantId: 'participant-alice', creatorDeviceId: 'device-alice', revision: 4, eventCount: 3,
    });
    expect(records[2]).toEqual({
      record: 'participant', v: 1, participantId: 'participant-alice', kind: 'human', displayName: 'Alice',
      membership: 'joined', deviceIds: ['device-alice'],
    });
    expect(records.slice(4).map(record => [record['sequence'], record['authorParticipantId'], record['content']])).toEqual([
      [1, 'participant-bob', { v: 1, kind: 'text', body: HOSTILE_BODY }],
      [2, 'participant-alice', { v: 1, kind: 'text', body: '' }],
      [3, 'participant-bob', { v: 1, kind: 'text', body: '\u{1F600} ‮' }],
    ]);
  });

  it('exports null-title and empty-history channels deterministically', () => {
    const root = makeRoot(roots);
    seedChannel(root, 'channel-one', [], { title: null });
    const out = outputDirectory();
    expect(run(root, path.join(out, 'c.md'), 'markdown').kind).toBe('exported');
    const markdown = fs.readFileSync(path.join(out, 'c.md'), 'utf8');
    expect(markdown).toContain('- Title: ` null `');
    expect(markdown.endsWith('No messages.\n')).toBe(true);
  });

  it('omits bindings, sessions, owners, operations, transaction IDs, digests and launch material', () => {
    const root = makeRoot(roots);
    seedChannel(root, 'channel-one', [{ author: 'bob', body: 'visible body' }]);
    const out = outputDirectory();
    for (const format of ['markdown', 'jsonl'] as const) {
      const destination = path.join(out, `x.${format}`);
      expect(run(root, destination, format).kind).toBe('exported');
      const contents = fs.readFileSync(destination, 'utf8');
      expect(contents).toContain('visible body');
      for (const canary of SECRET_CANARIES) expect(contents).not.toContain(canary);
    }
  });

  it('refuses a running channel and missing state without writing output', () => {
    const root = makeRoot(roots);
    seedChannel(root, 'channel-one');
    const out = outputDirectory();
    const handle = openChannelStore({ directory: directoryFor(root, 'channel-one'), mode: 'existing' });
    handles.push(handle);
    expect(run(root, path.join(out, 'x.md'), 'markdown')).toEqual({ kind: 'failed', code: 'channel_running' });
    expect(exportInternalChannel({
      root, channelId: 'channel-missing', format: 'jsonl', destination: path.join(out, 'y.jsonl'), overwrite: 'refuse',
    })).toEqual({ kind: 'failed', code: 'missing_state' });
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('refuses a tampered canonical message instead of exporting altered content', () => {
    const root = makeRoot(roots);
    seedChannel(root, 'channel-one', [{ author: 'alice', body: 'original' }], {
      extra: handle => handle.transaction(db => {
        db.prepare("UPDATE events SET canonical_payload = CAST('[1,\"text\",\"forged\"]' AS BLOB)").run();
      }),
    });
    const out = outputDirectory();
    expect(run(root, path.join(out, 'x.jsonl'), 'jsonl')).toEqual({ kind: 'failed', code: 'corrupt' });
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('refuses an existing destination by default and replaces it atomically only when asked', () => {
    const root = makeRoot(roots);
    seedChannel(root, 'channel-one', [{ author: 'alice', body: 'fresh' }]);
    const out = outputDirectory();
    const destination = path.join(out, 'channel.jsonl');
    fs.writeFileSync(destination, 'previous');
    expect(run(root, destination, 'jsonl')).toEqual({ kind: 'failed', code: 'destination_exists' });
    expect(fs.readFileSync(destination, 'utf8')).toBe('previous');
    expect(run(root, destination, 'jsonl', 'replace').kind).toBe('exported');
    expect(fs.readFileSync(destination, 'utf8')).toContain('"fresh"');
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(out)).toEqual(['channel.jsonl']);
  });

  it('refuses unsafe destinations including symlinks, directories and missing parents', () => {
    const root = makeRoot(roots);
    seedChannel(root, 'channel-one');
    const out = outputDirectory();
    const victim = path.join(out, 'victim');
    fs.writeFileSync(victim, 'untouched');
    fs.symlinkSync(victim, path.join(out, 'link.md'));
    fs.mkdirSync(path.join(out, 'dir.md'));
    for (const overwrite of ['refuse', 'replace'] as const) {
      expect(run(root, path.join(out, 'link.md'), 'markdown', overwrite)).toEqual({ kind: 'failed', code: 'destination_unsafe' });
      expect(run(root, path.join(out, 'dir.md'), 'markdown', overwrite)).toEqual({ kind: 'failed', code: 'destination_unsafe' });
    }
    expect(run(root, path.join(out, 'missing', 'x.md'), 'markdown')).toEqual({ kind: 'failed', code: 'destination_unsafe' });
    expect(run(root, 'relative.md', 'markdown')).toEqual({ kind: 'failed', code: 'destination_unsafe' });
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
  });

  it('preserves a destination that appears after the temporary is synced', () => {
    const root = makeRoot(roots);
    seedChannel(root, 'channel-one', [{ author: 'alice', body: 'mine' }]);
    const out = outputDirectory();
    const destination = path.join(out, 'race.md');
    const result = run(root, destination, 'markdown', 'refuse', stage => {
      if (stage === 'after_sync') fs.writeFileSync(destination, 'racing writer');
    });
    expect(result).toEqual({ kind: 'failed', code: 'destination_exists' });
    expect(fs.readFileSync(destination, 'utf8')).toBe('racing writer');
    expect(fs.readdirSync(out)).toEqual(['race.md']);

    expect(run(root, destination, 'markdown', 'replace', stage => {
      if (stage === 'after_sync') fs.writeFileSync(destination, 'racing writer 2');
    }).kind).toBe('exported');
    expect(fs.readFileSync(destination, 'utf8')).toContain('mine');
    expect(fs.readdirSync(out)).toEqual(['race.md']);
  });

  it('never exposes a partial file when writing, syncing or publishing is interrupted', () => {
    const root = makeRoot(roots);
    seedChannel(root, 'channel-one', [{ author: 'alice', body: 'x'.repeat(10_000) }]);
    const out = outputDirectory();
    const before = tree(root);
    for (const stage of ['partial_write', 'after_sync', 'before_publish'] as const) {
      for (const overwrite of ['refuse', 'replace'] as const) {
        const destination = path.join(out, `${stage}-${overwrite}.md`);
        if (overwrite === 'replace') fs.writeFileSync(destination, 'old complete export');
        const result = run(root, destination, 'markdown', overwrite, current => {
          if (current === stage) throw new Error('injected');
        });
        expect(result).toEqual({ kind: 'failed', code: 'write_failed' });
        if (overwrite === 'replace') {
          expect(fs.readFileSync(destination, 'utf8')).toBe('old complete export');
        } else {
          expect(fs.existsSync(destination)).toBe(false);
        }
      }
    }
    expect(fs.readdirSync(out).sort()).toEqual([
      'after_sync-replace.md', 'before_publish-replace.md', 'partial_write-replace.md',
    ]);
    expect(tree(root)).toEqual(before);
  });
});
