// Record how the person's Cursor session actually started. Run after they open
// the project in Cursor and before they start Agent Chat. Nothing here launches
// anything: it reads the running app process, and takes the trust settings the
// person reads off Cursor's Agent settings (decision 33). The verifier, not this
// script, decides whether those settings are normal.
//   node record-launch.mjs <state> --app-pid <pid> --auto-run <ask|allowlist|sandbox|run-everything> --mcp-auto-run <on|off>
//   node record-launch.mjs <state> --cloud-agent <id> --cloud-created-at <iso> --auto-run <...> --mcp-auto-run <...>
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ancestry, listProcesses } from './processes.mjs';

const { positionals: [state], values } = parseArgs({
  allowPositionals: true,
  options: {
    'app-pid': { type: 'string' },
    'cloud-agent': { type: 'string' },
    'cloud-created-at': { type: 'string' },
    'auto-run': { type: 'string' },
    'mcp-auto-run': { type: 'string' },
  },
});
if (!state || !values['auto-run'] || !values['mcp-auto-run'] || !(values['app-pid'] || values['cloud-agent'])) {
  throw new Error('usage: record-launch.mjs <state> (--app-pid <pid> | --cloud-agent <id> --cloud-created-at <iso>) --auto-run <setting> --mcp-auto-run <on|off>');
}

const recordedAt = new Date().toISOString();
const trust = { autoRun: values['auto-run'], mcpAutoRun: values['mcp-auto-run'] };
let launch;
if (values['app-pid']) {
  const pid = Number(values['app-pid']);
  const processes = listProcesses();
  const app = processes.find(proc => proc.pid === pid);
  if (!app) throw new Error(`no process ${pid}`);
  launch = { recordedAt, app: { ...app, ancestors: ancestry(pid, processes) }, trust };
} else {
  launch = { recordedAt, cloudAgent: { id: values['cloud-agent'], createdAt: values['cloud-created-at'] ?? null }, trust };
}
await writeFile(join(state, 'launch.json'), `${JSON.stringify(launch, null, 2)}\n`, { mode: 0o600 });

// The store stamps run.json's launch onto every event it logs.
const run = JSON.parse(await readFile(join(state, 'run.json'), 'utf8'));
run.launch = launch.app ? launch.app.argv : ['cursor-cloud-agent', launch.cloudAgent.id];
await writeFile(join(state, 'run.json'), `${JSON.stringify(run)}\n`);
