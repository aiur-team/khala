import { expect, it } from 'vitest';
import { CURSOR_DEFAULT_SESSION, cursorSessionId, normalizeWorkspace } from './cursor';
import { resolveHarness, resolveSessionId } from './mcp/session-id';

it('normalizes the workspace forms Cursor hands MCP servers and hooks on Windows', () => {
  const forms = ['C:\\Users\\Ada\\proj', 'c:/Users/Ada/proj/', '/c:/Users/Ada/proj', 'file:///c%3A/Users/Ada/proj', 'C:\\Users\\ADA\\Proj\\'];
  expect(new Set(forms.map(normalizeWorkspace))).toEqual(new Set(['c:/users/ada/proj']));
  expect(new Set(forms.map(cursorSessionId)).size).toBe(1);
  expect(normalizeWorkspace('C:\\')).toBe('c:/');
});

it('keeps POSIX paths case-sensitive and falls back to the default session', () => {
  expect(normalizeWorkspace('/home/a/Proj/')).toBe('/home/a/Proj');
  expect(cursorSessionId('/home/a/Proj')).not.toBe(cursorSessionId('/home/a/proj'));
  expect(cursorSessionId('/home/a/Proj')).toMatch(/^ws-[0-9a-f]{32}$/u);
  for (const value of [undefined, '', '  ', '${workspaceFolder}']) expect(cursorSessionId(value)).toBe(CURSOR_DEFAULT_SESSION);
});

it('resolves the cursor harness and its workspace session for MCP', () => {
  expect(resolveHarness(['--harness', 'cursor'], {})).toBe('cursor');
  expect(resolveHarness([], { KHALA_MCP_HARNESS: 'cursor' })).toBe('cursor');
  expect(resolveSessionId('cursor', { threadId: 'ignored' }, { KHALA_CURSOR_WORKSPACE: '/w' })).toBe(cursorSessionId('/w'));
  expect(resolveSessionId('cursor', undefined, {})).toBe(CURSOR_DEFAULT_SESSION);
});
