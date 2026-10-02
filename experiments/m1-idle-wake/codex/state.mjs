import fs from 'node:fs';
import path from 'node:path';
export const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);
export const root = () => path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME, '.local/state'), 'khala/codex');
export function directory(id) {
  if (!validId(id)) throw new Error('invalid session id');
  return path.join(root(), id);
}
export function read(dir, name) { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
export function write(dir, name, value) {
  const target = path.join(dir, name), temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value) + '\n', {mode: 0o600});
  fs.renameSync(temp, target);
}
export function log(dir, value) {
  fs.appendFileSync(path.join(dir, 'spike-log.jsonl'), JSON.stringify({at: new Date().toISOString(), ...value}) + '\n', {mode: 0o600});
}
export function entries(dir) {
  return fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export function unread(dir) {
  const all = entries(dir), cursor = read(dir, 'cursor.json');
  if (cursor.lastDeliveredEventId === null) return all;
  const index = all.findIndex(entry => entry.eventId === cursor.lastDeliveredEventId);
  if (index < 0) throw new Error('cursor missing from inbox');
  return all.slice(index + 1);
}
export function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error('expected option');
    result[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
  return result;
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
