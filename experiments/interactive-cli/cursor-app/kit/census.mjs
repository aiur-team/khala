// Capture the raw process census into a trial's state directory. The person runs
// it while the trial is under way, after the first batch arrives.
//   node census.mjs <state>
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listProcesses } from './processes.mjs';

const [state] = process.argv.slice(2);
if (!state) throw new Error('usage: census.mjs <state>');
await writeFile(join(state, 'census.json'), `${JSON.stringify({
  at: new Date().toISOString(), platform: process.platform, processes: listProcesses(),
})}\n`, { mode: 0o600 });
