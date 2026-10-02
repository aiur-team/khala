import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {directory, read, unread, log, options, sleep} from './state.mjs';
export const NOTICE = 'Khala: channel messages are waiting. Continue.';
export const ALLOWLIST = ['PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL','TMPDIR','CODEX_HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR'];
export const scrubbedQueueEnv = source => Object.fromEntries(ALLOWLIST.filter(key=>source[key] !== undefined).map(key=>[key,source[key]]));
export async function tick(id, ifIdle) {
  const lock = path.join(directory(id), 'waker-lock');
  try { fs.mkdirSync(lock, {mode:0o700}); } catch(error) { if(error.code === 'EEXIST') return false; throw error; }
  try {
  const dir = directory(id), activity = read(dir,'activity.json'), marker = path.join(dir,'wake-pending');
  if (!unread(dir).some(entry=>entry.kind === 'message') || (ifIdle && activity.state !== 'idle')) return false;
  if (fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker,'utf8')).at >= activity.updatedAt) return false;
  // Exclusive creation prevents concurrent wakers from queuing the same offer.
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
  try { fs.writeFileSync(marker, JSON.stringify({at:new Date().toISOString()}), {mode:0o600, flag:'wx'}); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  const exitCode = await new Promise(resolve => {
    const child = spawn('codex',['queue','--thread',id,'--message',NOTICE],{shell:false,stdio:'ignore',env:scrubbedQueueEnv(process.env)});
    let force;
    const timer = setTimeout(()=>{child.kill('SIGTERM'); force=setTimeout(()=>child.kill('SIGKILL'),500);},10000);
    const done = code => {clearTimeout(timer);clearTimeout(force);resolve(code);};
    child.once('error',()=>done(-1));child.once('close',code=>done(code ?? -1));
  });
  log(dir,{role:'waker',queued:exitCode === 0,exitCode});
  return true;
  } finally { fs.rmdirSync(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = options(process.argv.slice(2)), started = Date.now();
  do {
    if (await tick(opts.session,opts['if-idle']) && opts.once) break;
    if (opts.once && Date.now()-started >= 30000) break;
    await sleep(500);
  } while (true);
}
