import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkTerminology } from './check-terminology.mjs';

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-terminology-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, body);
  }
  return { root, errors: checkTerminology(root) };
}

test('rejects direct and constant-backed room copy', t => {
  const { errors } = fixture(t, { 'apps/web/src/Screen.tsx': `const status = 'Joining the room…'; export const Screen = () => <><p aria-label="Room status">{status}</p><strong>Room</strong></>;` });
  assert.equal(errors.length, 3);
  assert(errors.some(error => error.includes('Joining the room')));
  assert(errors.some(error => error.includes('Room status')));
  assert(errors.some(error => error.includes('"Room"')));
});

test('accepts channel copy and non-visible compatibility identifiers', t => {
  const { errors } = fixture(t, {
    'apps/web/src/Screen.tsx': `import type { RoomId } from '@khala/contracts/messaging/index'; const roomId = 'room-1' as RoomId; export const Screen = () => <p className="room-screen">Channel {roomId}</p>;`,
    'packages/agent-cli/src/validation.ts': `export const keys = ['roomId', 'm.room.message', '/_matrix/client/v3/rooms/id'];`,
  });
  assert.deepEqual(errors, []);
});

test('accepts explicit Matrix room terminology', t => {
  const { errors } = fixture(t, { 'apps/web/src/MatrixStatus.tsx': `export const MatrixStatus = () => <p>Matrix room unavailable</p>;` });
  assert.deepEqual(errors, []);
});

test('rejects hyphenated and mixed room copy while retaining individual Matrix allowances', t => {
  const { errors } = fixture(t, {
    'apps/web/src/Screen.tsx': `export const Screen = () => <><p>Room-overview</p><p>room-overview</p><p>Matrix room and Room overview</p><p>m.room.message and Room overview</p></>;`,
  });
  assert.equal(errors.length, 4);
  assert(errors.some(error => error.includes('Room-overview')));
  assert(errors.some(error => error.includes('room-overview')));
  assert.equal(errors.filter(error => error.includes('Room overview')).length, 2);
});

test('scans landing text, visible attributes and browser harnesses but ignores tests', t => {
  const { errors } = fixture(t, {
    'apps/web/src/landing/index.html': `<h1 title="Room overview">Open a room</h1>`,
    'apps/web/src/ignored.test.tsx': `export const value = <p>Room</p>;`,
    'apps/web/src/browser-harness/main.tsx': `export const value = <p>Room</p>;`,
  });
  assert.equal(errors.length, 3);
  assert(errors.some(error => error.startsWith('apps/web/src/browser-harness/main.tsx:1:')));
});

test('scans multiline landing text and visible attributes', t => {
  const { errors } = fixture(t, {
    'apps/web/src/landing/index.html': `<h1>\n  Room overview\n</h1>\n<img\n  title="Room overview"\n>`,
  });
  assert.equal(errors.length, 2);
  assert(errors.some(error => error.includes(':2:')));
  assert(errors.some(error => error.includes(':5:')));
});

test('invalid terminology makes the command fail for CI', t => {
  const { root } = fixture(t, { 'packages/agent-cli/src/help.ts': `export const help = 'Connect to a room';` });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-terminology.mjs', import.meta.url)), root], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Connect to a room/);
});

test('treats every string attribute as visible except machine attributes', t => {
  const { errors } = fixture(t, {
    'apps/web/src/Screen.tsx': `export const Screen = () => <><Panel heading="Join this room" /><StatusBadge label={'Room ready'} /><div className="room-card" id="room-panel" data-room="x" aria-labelledby="room-heading" aria-describedby="room-help" htmlFor="room-input" name="room" href="/room" key="room" type="room" value="room" /><input className={'room-input'} /></>;`,
    'apps/web/src/landing/index.html': `<meta name="room" content="Open a room"><div id="room" class="room" data-room="room" aria-label="Room list"></div>`,
  });
  assert.equal(errors.length, 4);
  assert(errors.some(error => error.includes('Join this room')));
  assert(errors.some(error => error.includes('Room ready')));
  assert(errors.some(error => error.includes('Open a room')));
  assert(errors.some(error => error.includes('Room list')));
});

test('rejects chat nouns but accepts the verb and the splash sentence', t => {
  const { errors } = fixture(t, {
    'apps/web/src/Screen.tsx': `export const Screen = () => <><p>Start a chat</p><p title="Chat history">x</p><p>Agents chat in a channel.</p><p>Your agents chat with each other</p><p>Open the chat with your agent</p></>;`,
    'packages/agent-cli/src/help.ts': `export const help = ['Leave the chat', 'chat_id'];`,
    'apps/web/src/landing/index.html': `<p class="features-intro"><span class="accent">Encrypted chat</span> for humans and their agents.</p><p>Encrypted chat for everyone.</p>`,
  });
  assert.equal(errors.length, 5);
  assert(errors.some(error => error.includes('Start a chat')));
  assert(errors.some(error => error.includes('Chat history')));
  assert(errors.some(error => error.includes('Open the chat with your agent')));
  assert(errors.some(error => error.includes('Leave the chat')));
  assert(errors.some(error => error.includes('Encrypted chat for everyone.')));
});

test('honours reasoned inline suppressions on the same or preceding line only', t => {
  const { errors } = fixture(t, {
    'apps/web/src/storage.ts': [
      '// khala-terminology-allow: persisted storage key must stay stable',
      `export const journalKey = 'khala.room-journal.v1';`,
      `export const route = '/rooms/'; // khala-terminology-allow: legacy route kept for old links`,
      '// khala-terminology-allow:',
      `export const unreasoned = 'khala.room-cache.v1';`,
      '',
      `export const tooFar = 'khala.room-draft.v1';`,
    ].join('\n'),
    'apps/web/src/landing/index.html': `<!-- khala-terminology-allow: anchor for old room links -->\n<p>Room directory</p>\n\n<p>Room index</p>`,
  });
  assert.deepEqual(errors, [
    'apps/web/src/landing/index.html:4: user-facing Khala copy uses "Room index"',
    'apps/web/src/storage.ts:5: user-facing Khala copy uses "khala.room-cache.v1"',
    'apps/web/src/storage.ts:7: user-facing Khala copy uses "khala.room-draft.v1"',
  ]);
});
