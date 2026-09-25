// Stands in for a browser: loads the target (a URL, or a handoff file whose
// script navigates to one), performs the bootstrap exchange from the fragment
// in-process, then stays alive like a browser window until it is killed.
import { readFileSync } from 'node:fs';

const target = process.argv[2];
const url = new URL(target.startsWith('http')
  ? target
  : JSON.parse(readFileSync(target, 'utf8').match(/location\.replace\((".*?")\)/)[1]));
const fragment = new URLSearchParams(url.hash.slice(1));
await fetch(new URL('/__khala/session', url.origin), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ credential: fragment.get('credential'), channelId: fragment.get('channel') }),
});
setInterval(() => {}, 1_000);
