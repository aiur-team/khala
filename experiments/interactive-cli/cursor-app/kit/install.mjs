// Prepare a person's scratch Cursor project for one trial. Run by hand, before
// the person opens the project in Cursor and starts Agent Chat themselves.
// Nothing has launched yet, so the launch is left for record-launch.mjs.
//   node install.mjs <project> <run-id> <local_chat|cloud_task> <cursor-version> <account-tier> <policy-scope>
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [project, runId, shape, appVersion, accountTier, administratorPolicyScope] = process.argv.slice(2);
if (!administratorPolicyScope) throw new Error('usage: install.mjs <project> <run-id> <shape> <cursor-version> <account-tier> <policy-scope>');
if (!['local_chat', 'cloud_task'].includes(shape)) throw new Error('shape must be local_chat or cloud_task');

const kit = resolve(import.meta.dirname);
const root = resolve(project);
const state = `${root}.khala-state`;
const hook = { command: `node ${JSON.stringify(join(kit, 'hook.mjs'))}` };

await mkdir(join(root, '.cursor'), { recursive: true });
await writeFile(join(root, '.cursor/hooks.json'), `${JSON.stringify({
  version: 1,
  hooks: {
    sessionStart: [hook],
    beforeSubmitPrompt: [hook],
    preToolUse: [hook],
    postToolUse: [hook],
    beforeMCPExecution: [hook],
    // loop_limit backs up the hook's own one-follow-up-per-turn rule.
    stop: [{ ...hook, loop_limit: 1 }],
  },
}, null, 2)}\n`);
await writeFile(join(root, '.cursor/mcp.json'), `${JSON.stringify({
  mcpServers: { khala: { command: 'node', args: [join(kit, 'mcp.mjs')], env: { KHALA_PROOF_STATE: state } } },
}, null, 2)}\n`);

await mkdir(state, { recursive: true, mode: 0o700 });
await writeFile(join(state, 'run.json'), `${JSON.stringify({
  runId, app: 'cursor', shape, cliVersion: appVersion, accountTier, administratorPolicyScope,
})}\n`);
process.stdout.write(`${state}\n`);
