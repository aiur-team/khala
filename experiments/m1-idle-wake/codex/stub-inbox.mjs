import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {directory, root, validId, write, log, options, sleep} from './state.mjs';
const [command, ...args] = process.argv.slice(2), opts = options(args);
if (opts.harness && opts.harness !== 'codex') throw new Error('harness must be codex');
if (command === 'log') {
  const dirs = opts.session ? [directory(opts.session)] : fs.readdirSync(root()).filter(validId).map(id => directory(id));
  for (const dir of dirs) {
    const file = path.join(dir, 'spike-log.jsonl');
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      if (!opts.since || JSON.parse(line).at >= opts.since) console.log(line);
    }
  }
} else {
  const dir = directory(opts.session);
  if (command === 'init') {
    if (fs.existsSync(dir)) throw new Error('state already exists; refusing reset');
    fs.mkdirSync(dir, {recursive:true, mode:0o700});
    fs.chmodSync(dir, 0o700);
    write(dir, 'cursor.json', {lastDeliveredEventId:null, deliveredCount:0});
    write(dir, 'status.json', {state:'connected', channelName:opts.channel || 'spike', updatedAt:new Date().toISOString()});
    write(dir, 'activity.json', {state:'idle', updatedAt:new Date().toISOString()});
    fs.writeFileSync(path.join(dir, 'inbox.jsonl'), '', {mode:0o600});
    log(dir, {role:'init', sessionId:opts.session});
  } else if (command === 'append') {
    const count = Number(opts.count || 1), gap = Number(opts['gap-ms'] || 0), delay = Number(opts['delay-ms'] || 0);
    if (!Number.isSafeInteger(count) || count < 1 || count > 100 || !Number.isFinite(gap) || gap < 0 || !Number.isFinite(delay) || delay < 0 || typeof opts.body !== 'string') throw new Error('invalid append options');
    await sleep(delay);
    for (let i = 0; i < count; i++) {
      if (i) await sleep(gap);
      const entry = {eventId:randomUUID(), roomId:'spike', ts:new Date().toISOString(), sender:'spike-human', senderLabel:opts['sender-label'] || 'Maya', senderKind:'human', kind:'message', body:opts.body + (count > 1 ? ` #${i}` : '')};
      fs.appendFileSync(path.join(dir, 'inbox.jsonl'), JSON.stringify(entry) + '\n', {mode:0o600});
      log(dir, {role:'append', eventId:entry.eventId, appendedAt:entry.ts, body:entry.body});
    }
  } else throw new Error('expected init, append or log');
}
