import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {cleanupWorkers,stopWorker} from '../src/shutdown.ts';

test('unexpected worker exit before cleanup still removes owned filesystem state',async()=>{
 const directory=await mkdtemp(`${homedir()}/.cache/khala-exit-`);
 const child=spawn(process.execPath,['-e','process.exit(9)'],{stdio:['ignore','ignore','ignore','ipc']});
 await once(child,'exit');assert.equal(child.exitCode,9);
 await cleanupWorkers([child],()=>rm(directory,{recursive:true,force:true}));
 await assert.rejects(stat(directory),error=>error.code==='ENOENT');
});
test('uncooperative disconnected worker is forcibly stopped within a bounded deadline',async()=>{
 const child=spawn(process.execPath,['-e','process.on("disconnect",()=>{});setInterval(()=>{},1000);process.send("ready")'],{stdio:['ignore','ignore','ignore','ipc']});
 await once(child,'message');
 await stopWorker(child,100);
 assert.equal(child.signalCode,'SIGKILL');
});
