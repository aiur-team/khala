import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sessionTitleName } from './session-title';

let root: string;
const id = '8f150525-f29c-4409-addf-25c28c19366d';
const jsonl = (...entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-title-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function claudeTranscript(contents: string, config = path.join(root, 'claude')) {
  await fs.mkdir(path.join(config, 'projects', '-home-me-other'), { recursive: true });
  await fs.mkdir(path.join(config, 'projects', '-home-me-repo'), { recursive: true });
  await fs.writeFile(path.join(config, 'projects', '-home-me-repo', `${id}.jsonl`), contents);
}

it('reads the last Claude /rename title from CLAUDE_CONFIG_DIR, never the automatic ai-title', async () => {
  await claudeTranscript(jsonl(
    { type: 'user', message: { role: 'user', content: 'say "custom-title"' } },
    { type: 'custom-title', customTitle: 'First Name', sessionId: id },
    { type: 'custom-title', customTitle: 'PC - Kevin', sessionId: id },
    { type: 'ai-title', aiTitle: 'Automatic Summary', sessionId: id },
    { type: 'summary', summary: 'Also automatic' },
  ) + '{"type":"custom-title","customTi');
  expect(await sessionTitleName('claude', id, { CLAUDE_CONFIG_DIR: path.join(root, 'claude') })).toBe('PC-Kevin');
});

it('falls back to HOME/.claude and ignores sessions without a user-set title', async () => {
  await claudeTranscript(jsonl({ type: 'ai-title', aiTitle: 'Automatic Summary', sessionId: id }), path.join(root, '.claude'));
  expect(await sessionTitleName('claude', id, { HOME: root })).toBeNull();
  expect(await sessionTitleName('claude', 'missing-session', { HOME: root })).toBeNull();
});

it('reads the newest Codex thread name for this thread from CODEX_HOME', async () => {
  await fs.writeFile(path.join(root, 'session_index.jsonl'), jsonl(
    { id, thread_name: 'old name', updated_at: '2026-10-01T00:00:00Z' },
    { id: 'other-thread', thread_name: 'Not Mine', updated_at: '2026-10-02T00:00:00Z' },
    { id, thread_name: 'My Cool Chat!', updated_at: '2026-10-03T00:00:00Z' },
  ));
  expect(await sessionTitleName('codex', id, { CODEX_HOME: root })).toBe('MyCoolChat');
  expect(await sessionTitleName('codex', 'unnamed-thread', { CODEX_HOME: root })).toBeNull();
});

it('returns null for unsupported harnesses, unusable titles, unsafe ids and missing stores', async () => {
  await fs.writeFile(path.join(root, 'session_index.jsonl'), jsonl({ id, thread_name: '!!!' }));
  expect(await sessionTitleName('codex', id, { CODEX_HOME: root })).toBeNull();
  expect(await sessionTitleName('cursor', id, { HOME: root })).toBeNull();
  expect(await sessionTitleName('opencode', id, { HOME: root })).toBeNull();
  expect(await sessionTitleName('claude', '../escape', { HOME: root })).toBeNull();
  expect(await sessionTitleName('codex', id, { CODEX_HOME: path.join(root, 'absent') })).toBeNull();
});
