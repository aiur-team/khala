import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
const home=process.env.CODEX_HOME || path.join(process.env.HOME,'.codex');
const here=path.dirname(fileURLToPath(import.meta.url));
const hook=path.join(here,'hook.mjs');
const files=['hooks.json','config.toml'].map(name=>path.join(home,name));
const backups=files.map(file=>`${file}.km112.bak`);
function toml(text) {
  const child=spawnSync('python3',['-c','import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'],{input:text,encoding:'utf8'});
  if (child.status !== 0) throw new Error('unparsable TOML (Python 3.11+ required); no restore performed');
  return JSON.parse(child.stdout);
}
const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
function groups() {
  return Object.fromEntries(['UserPromptSubmit','Stop','PreToolUse','PostToolUse'].map(event=>[event,[{hooks:[{type:'command',command:`node ${shellQuote(hook)} ${['UserPromptSubmit','Stop'].includes(event)?'deliver':'log'}`,timeout:10}]}]]));
}
if (process.argv[2] === 'install') {
  if (backups.some(file=>fs.existsSync(file))) throw new Error('backup exists; refusing install');
  const original=files.map(file=>fs.readFileSync(file));
  const hooks=JSON.parse(original[0]), config=toml(original[1].toString());
  if (config.mcp_servers?.khala_spike) throw new Error('khala_spike already exists');
  hooks.hooks ??= {};
  for (const [event,group] of Object.entries(groups())) {
    if (hooks.hooks[event] !== undefined && !Array.isArray(hooks.hooks[event])) throw new Error('invalid hook groups');
    hooks.hooks[event] = [...(hooks.hooks[event] || []), ...group];
  }
  const configText=original[1].toString()+`\n[mcp_servers.khala_spike]\ncommand = "node"\nargs = [${JSON.stringify(path.join(here,'probe-mcp.mjs'))}]\n`;
  toml(configText);
  for (let i=0;i<2;i++) fs.writeFileSync(backups[i],original[i],{flag:'wx',mode:0o600});
  try {fs.writeFileSync(files[0],JSON.stringify(hooks,null,2)+'\n');fs.writeFileSync(files[1],configText);}
  catch (error) {for(let i=0;i<2;i++) fs.writeFileSync(files[i],original[i]);throw error;}
  console.log('installed; review and trust only the spike hooks');
} else if (process.argv[2] === 'uninstall') {
  const original=backups.map(file=>fs.readFileSync(file));
  const live=toml(fs.readFileSync(files[1],'utf8')), before=toml(original[1].toString());
  delete live.mcp_servers?.khala_spike;
  if (live.mcp_servers && !Object.keys(live.mcp_servers).length && !before.mcp_servers) delete live.mcp_servers;
  for (const key of Object.keys(live.hooks?.state || {})) {
    // Trust keys contain config path + event + positional group + handler, not command.
    const prefix=files[0]+':';
    const tail=key.startsWith(prefix) ? key.slice(prefix.length).split(':') : [];
    const event=tail[0], index=Number(tail[1]);
    const originalHooks=JSON.parse(original[0]);
    if (tail.length === 3 && event in groups() && index === (originalHooks.hooks?.[event]?.length || 0) && tail[2] === '0') delete live.hooks.state[key];
  }
  if (live.hooks?.state && !Object.keys(live.hooks.state).length && !before.hooks?.state) delete live.hooks.state;
  if (live.hooks && !Object.keys(live.hooks).length && !before.hooks) delete live.hooks;
  if (!isDeepStrictEqual(live,before)) throw new Error('unrelated config changes: stop and report to Executor; backups retained');
  const liveHooks=JSON.parse(fs.readFileSync(files[0],'utf8')), oldHooks=JSON.parse(original[0]);
  for (const [event,group] of Object.entries(groups())) {
    const n=oldHooks.hooks?.[event]?.length || 0;
    if (!isDeepStrictEqual(liveHooks.hooks?.[event]?.slice(n),group)) throw new Error('spike hooks changed; refusing restore');
    liveHooks.hooks[event]=liveHooks.hooks[event].slice(0,n);
    if (!oldHooks.hooks?.[event]) delete liveHooks.hooks[event];
  }
  if (!oldHooks.hooks && !Object.keys(liveHooks.hooks).length) delete liveHooks.hooks;
  if (!isDeepStrictEqual(liveHooks,oldHooks)) throw new Error('unrelated hooks changes; refusing restore');
  for (let i=0;i<2;i++) fs.writeFileSync(files[i],original[i]);
  for (const file of backups) fs.unlinkSync(file);
  console.log('restored byte-for-byte');
} else throw new Error('expected install or uninstall');
