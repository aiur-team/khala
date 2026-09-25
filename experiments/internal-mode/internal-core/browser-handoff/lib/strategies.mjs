// Handoff strategies. Each returns the exact opener argv plus a cleanup hook.
//
// `argv-url` is the conventional default-browser handoff and the negative
// control: the fragment URL is opener argv, so the opener and the browser it
// starts both carry the credential in /proc/<pid>/cmdline.
//
// `private-file` is the selected safer handoff: the credential-bearing URL is
// written into a 0600 HTML file inside a fresh 0700 directory and only that
// file's path is handed to the opener. The browser reads the file as the
// launching user and navigates in-process, so no argv ever carries the URL.

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const STRATEGIES = Object.freeze(['argv-url', 'private-file']);

export function handoffDocument(url) {
  return Buffer.from([
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<title>Khala</title>',
    `<script>location.replace(${JSON.stringify(url)});</script>`,
    '</head>',
    '<body></body>',
    '</html>',
    '',
  ].join('\n'), 'utf8');
}

export async function prepareHandoff(strategy, { url, parentDir }) {
  if (strategy === 'argv-url') {
    return { argv: [url], privatePaths: [], cleanup: async () => {} };
  }
  if (strategy === 'private-file') {
    const dir = await mkdtemp(join(parentDir, 'handoff-'));
    await chmod(dir, 0o700);
    const file = join(dir, 'open.html');
    await writeFile(file, handoffDocument(url), { mode: 0o600, flag: 'wx' });
    return {
      argv: [file],
      privatePaths: [dir, file],
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }
  throw new Error(`unknown handoff strategy: ${strategy}`);
}
