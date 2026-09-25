import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoreErrorCode } from './errors';
import { ROOM_DATABASE_FILE } from './path';
import { openChannelStore } from './open';
import { APPLICATION_ID, CORE_SCHEMA_V1_SQL, SCHEMA_VERSION } from './schema';

const roots: string[] = [];
const handles: Array<{ close(): void }> = [];
const children: Array<ReturnType<typeof spawn>> = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) {
    try { fs.chmodSync(root, 0o700); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function scratchDirectory(): string {
  const root = fs.mkdtempSync(path.join('/tmp', 'khala-internal-store-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  return path.join(root, 'channel');
}

function file(directory: string): string {
  return path.join(directory, ROOM_DATABASE_FILE);
}

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

function open(directory: string, mode: 'create' | 'existing' = 'create') {
  const handle = openChannelStore({ directory, mode });
  handles.push(handle);
  return handle;
}

function openError(directory: string, mode: 'create' | 'existing' = 'create'): StoreErrorCode {
  try {
    open(directory, mode);
  } catch (error) {
    return (error as { code: StoreErrorCode }).code;
  }
  throw new Error('open unexpectedly succeeded');
}

function rewrite(target: string, sql: string): void {
  const db = new DatabaseSync(target);
  db.exec(sql);
  db.close();
  fs.chmodSync(target, 0o600);
}

function snapshot(directory: string): ReadonlyArray<readonly [string, string, number]> {
  return fs.readdirSync(directory).sort().map(name => {
    const target = path.join(directory, name);
    const stats = fs.lstatSync(target);
    return [name, stats.isFile() ? fs.readFileSync(target).toString('hex') : '', stats.mode & 0o777] as const;
  });
}

function createV1(directory: string): string {
  fs.mkdirSync(directory, { mode: 0o700 });
  const target = file(directory);
  const db = new DatabaseSync(target);
  db.exec('BEGIN IMMEDIATE');
  db.exec(CORE_SCHEMA_V1_SQL);
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  db.exec('PRAGMA user_version = 1');
  db.exec("INSERT INTO participants (participant_id, owner_id, kind, display_name) VALUES ('p1', 'o1', 'agent', 'Agent')");
  db.exec("INSERT INTO devices (device_id, participant_id) VALUES ('d1', 'p1')");
  db.exec('COMMIT');
  db.close();
  fs.chmodSync(target, 0o600);
  return target;
}

describe('openChannelStore', () => {
  it('creates exact owner-only directory, database and companion modes', () => {
    const directory = scratchDirectory();
    const handle = open(directory);
    expect(modeOf(directory)).toBe(0o700);
    expect(modeOf(file(directory))).toBe(0o600);
    expect(handle.read(db => db.prepare('PRAGMA application_id').get())).toEqual({ application_id: APPLICATION_ID });
    expect(handle.read(db => db.prepare('PRAGMA user_version').get())).toEqual({ user_version: SCHEMA_VERSION });
    expect(handle.read(db => db.prepare('PRAGMA foreign_keys').get())).toEqual({ foreign_keys: 1 });
    expect(handle.read(db => db.prepare('PRAGMA synchronous').get())).toEqual({ synchronous: 2 });
    for (const name of fs.readdirSync(directory)) expect(modeOf(path.join(directory, name))).toBe(0o600);
  });

  it('reopens current state and exposes all core and mode tables through one handle', () => {
    const directory = scratchDirectory();
    const first = open(directory);
    first.close();
    const second = open(directory, 'existing');
    expect(second.read(db => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
      .map(row => (row as { name: string }).name))).toEqual([
      'bindings', 'channel_operations', 'channels', 'devices', 'events', 'memberships',
      'meta', 'mode_controls', 'mode_operations', 'participants', 'sqlite_sequence',
    ]);
  });

  it('migrates a seeded v1 core database to the v2 mode schema without changing core rows', () => {
    const directory = scratchDirectory();
    createV1(directory);
    const handle = open(directory, 'existing');
    expect(handle.read(db => db.prepare('SELECT * FROM participants').get())).toMatchObject({ participant_id: 'p1' });
    expect(handle.read(db => db.prepare('SELECT * FROM devices').get())).toEqual({ device_id: 'd1', participant_id: 'p1' });
    expect(handle.read(db => db.prepare('PRAGMA user_version').get())).toEqual({ user_version: 2 });
    expect(handle.read(db => db.prepare("SELECT name FROM sqlite_schema WHERE name = 'mode_controls'").get()))
      .toEqual({ name: 'mode_controls' });
  });

  it('rolls every injected v1 migration failure back and retries from intact v1 state', () => {
    for (const stage of [
      'after_mode_controls', 'after_mode_operations', 'before_user_version', 'after_user_version',
    ] as const) {
      const directory = scratchDirectory();
      const target = createV1(directory);
      expect(() => openChannelStore({ directory, mode: 'existing', migrationFault: current => {
        if (current === stage) throw new Error('injected');
      } })).toThrow(expect.objectContaining({ code: 'transaction_aborted' }));
      const raw = new DatabaseSync(target, { readOnly: true });
      expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      expect(raw.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'mode_%'").all()).toEqual([]);
      expect(raw.prepare('SELECT participant_id FROM participants').get()).toEqual({ participant_id: 'p1' });
      raw.close();
      open(directory, 'existing');
    }
  });

  it('refuses missing and crash-abandoned empty existing state without creating anything', () => {
    const directory = scratchDirectory();
    expect(openError(directory, 'existing')).toBe('missing_state');
    fs.mkdirSync(directory, { mode: 0o700 });
    expect(openError(directory, 'existing')).toBe('missing_state');
    fs.writeFileSync(file(directory), '', { mode: 0o600 });
    const before = snapshot(directory);
    expect(openError(directory, 'existing')).toBe('corrupt');
    expect(openError(directory, 'create')).toBe('corrupt');
    expect(snapshot(directory)).toEqual(before);
  });

  it('refuses raw non-SQLite, foreign and newer files byte-for-byte without companions', () => {
    for (const fixture of ['corrupt', 'foreign', 'newer'] as const) {
      const directory = scratchDirectory();
      fs.mkdirSync(directory, { mode: 0o700 });
      const target = file(directory);
      if (fixture === 'corrupt') fs.writeFileSync(target, 'not sqlite'.repeat(30), { mode: 0o600 });
      else {
        rewrite(target, fixture === 'foreign'
          ? 'CREATE TABLE foreign_table (value TEXT) STRICT'
          : `CREATE TABLE future_table (value TEXT) STRICT; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      }
      const before = snapshot(directory);
      expect(openError(directory, 'existing')).toBe(fixture === 'newer' ? 'schema_unsupported' : 'corrupt');
      expect(snapshot(directory)).toEqual(before);
    }
  });

  it('rejects malformed current and v1 manifests, missing indexes and orphaned foreign keys', () => {
    const mutations = [
      'DROP INDEX events_channel_sequence',
      'PRAGMA foreign_keys = OFF; DROP TABLE devices; CREATE TABLE devices (device_id TEXT PRIMARY KEY, participant_id TEXT NOT NULL) STRICT',
      "PRAGMA foreign_keys = OFF; INSERT INTO devices (device_id, participant_id) VALUES ('orphan', 'missing')",
    ];
    for (const mutation of mutations) {
      const directory = scratchDirectory();
      const handle = open(directory);
      handle.close();
      rewrite(file(directory), mutation);
      expect(openError(directory, 'existing')).toBe('corrupt');
    }

    const v1Directory = scratchDirectory();
    const v1 = createV1(v1Directory);
    rewrite(v1, 'DROP INDEX events_channel_sequence');
    expect(openError(v1Directory, 'existing')).toBe('corrupt');
    const raw = new DatabaseSync(v1, { readOnly: true });
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    raw.close();
  });

  it('rejects relative, non-normal, symlinked and unsafe directory paths', () => {
    const directory = scratchDirectory();
    const root = path.dirname(directory);
    expect(openError('relative/channel')).toBe('unsafe_path');
    expect(openError(`${root}/x/../channel`)).toBe('unsafe_path');
    fs.mkdirSync(path.join(root, 'real'), { mode: 0o700 });
    fs.symlinkSync(path.join(root, 'real'), directory);
    expect(openError(directory)).toBe('unsafe_path');
    fs.unlinkSync(directory);
    fs.chmodSync(root, 0o777);
    expect(openError(directory)).toBe('unsafe_path');
  });

  it('rejects a non-sticky group-writable ancestor owned by the current group', () => {
    const directory = scratchDirectory();
    fs.chmodSync(path.dirname(directory), 0o770);
    expect(openError(directory)).toBe('unsafe_path');
  });

  it('rejects wrong directory, database and companion modes', () => {
    const directory = scratchDirectory();
    open(directory).close();
    fs.chmodSync(directory, 0o750);
    expect(openError(directory, 'existing')).toBe('unsafe_path');
    fs.chmodSync(directory, 0o700);
    fs.chmodSync(file(directory), 0o640);
    expect(openError(directory, 'existing')).toBe('unsafe_path');
    fs.chmodSync(file(directory), 0o600);
    fs.writeFileSync(file(directory) + '-journal', '', { mode: 0o640 });
    expect(openError(directory, 'existing')).toBe('unsafe_path');
  });

  it('rejects database and companion symlinks and hard links', () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const directory = scratchDirectory();
      fs.mkdirSync(directory, { mode: 0o700 });
      const elsewhere = path.join(path.dirname(directory), `elsewhere${suffix || '.sqlite'}`);
      fs.writeFileSync(elsewhere, 'x', { mode: 0o600 });
      fs.symlinkSync(elsewhere, file(directory) + suffix);
      expect(openError(directory, suffix === '' ? 'existing' : 'create')).toBe('unsafe_path');
      fs.unlinkSync(file(directory) + suffix);
      fs.linkSync(elsewhere, file(directory) + suffix);
      expect(openError(directory, suffix === '' ? 'existing' : 'create')).toBe('unsafe_path');
    }
  });

  it('allows one same-process owner at a time and recovers after close', () => {
    const directory = scratchDirectory();
    const first = open(directory);
    expect(openError(directory, 'existing')).toBe('locked');
    first.close();
    expect(() => first.read(db => db.prepare('SELECT 1').get())).toThrow(expect.objectContaining({ code: 'closed' }));
    open(directory, 'existing');
  });

  it('refuses a second process owner immediately and recovers after it is killed', async () => {
    const directory = scratchDirectory();
    open(directory).close();
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
      process.stdout.write('locked\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script, file(directory)], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
    });
    expect(openError(directory, 'existing')).toBe('locked');
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    children.splice(children.indexOf(child), 1);
    open(directory, 'existing');
  });
});
