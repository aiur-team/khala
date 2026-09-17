import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,mkdir,rm,unlink,readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {preview} from 'vite';
import {proof} from '../../backend/check.ts';

test('real browser/native encrypted peer exchange, trusted browser sharing, persisted history and abrupt native restart', {timeout:240000},async()=>{
 await mkdir('stores',{recursive:true});
 const directory=resolve(await mkdtemp('stores/live-'));
 const scratch=await mkdtemp(`${homedir()}/.cache/khala-live-`);
 const oldTemp=process.env.TMPDIR;process.env.TMPDIR=scratch;
 const server=await preview({preview:{host:'127.0.0.1',port:0}});
 let context,worker,seq=0;
 const launchWorker=()=>{worker=fork('src/live-worker.ts',[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc']});};
 const rpc=(message)=>new Promise((resolve,reject)=>{
  const id=++seq;const timer=setTimeout(()=>{worker.off('message',receive);reject(new Error(`native ${message.op} deadline`));},40000);
  function receive(reply){if(reply.id!==id)return;clearTimeout(timer);worker.off('message',receive);reply.error?reject(new Error(reply.error)):resolve(reply.result);}
  worker.on('message',receive);worker.send({...message,id});
 });
 const launchBrowser=async()=>{
  context=await chromium.launchPersistentContext(`${directory}/browser`,{executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,env:{...process.env,TMPDIR:scratch},args:['--no-sandbox']});
  const page=await context.newPage();await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>!!window.peer);return page;
 };
 try {
 await proof(async({baseUrl,alice,bob})=>{
  const api=async(path,token,body,method='POST')=>{const response=await fetch(baseUrl+'/_matrix/client/v3'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(response.ok,`Matrix HTTP ${response.status}`);return response.json();};
  const {room_id:room}=await api('/createRoom',alice.access_token,{visibility:'private',invite:[bob.user_id],initial_state:[{type:'m.room.encryption',state_key:'',content:{algorithm:'m.megolm.v1.aes-sha2'}}]});
  await api(`/join/${encodeURIComponent(room)}`,bob.access_token,{});
  launchWorker();const native=await rpc({op:'open',directory:`${directory}/native`,baseUrl,token:alice.access_token});
  let page=await launchBrowser();
  const config={baseUrl,userId:bob.user_id,deviceId:bob.device_id,accessToken:bob.access_token};
  const browserIdentity=await page.evaluate(config=>window.peer.open(config),config);
  console.log('both peers synced');
  const withheld=await page.evaluate(room=>window.peer.send(room,'unverified withheld fixture'),room);
  await assert.rejects(rpc({op:'decrypt',room,event:withheld.event_id,attempts:10}),/native missing room key after retry/);
  await assert.rejects(page.evaluate(({user,device})=>window.peer.trust(user,device,'wrong-fixture-fingerprint'),{user:alice.user_id,device:alice.device_id}),/fingerprint mismatch/);
  assert.equal(await page.evaluate(({user,device,fingerprint})=>window.peer.trust(user,device,fingerprint),{user:alice.user_id,device:alice.device_id,fingerprint:native.fingerprint}),true);
  await page.evaluate(room=>window.peer.discard(room),room);
  console.log("browser trusted native fingerprint");
  const nativeEvent=await rpc({op:'send',room,body:'native fixture'});
  console.log("native event submitted");
  assert.equal(await page.evaluate(({room,event})=>window.peer.decrypt(room,event),{room,event:nativeEvent}),'native fixture');
  const browserEvent=await page.evaluate(room=>window.peer.send(room,'browser fixture'),room);
  assert.equal((await rpc({op:'decrypt',room,event:browserEvent.event_id})).body,'browser fixture');
  console.log('bidirectional encrypted peer exchange passed');
  await context.close();page=await launchBrowser();
  assert.deepEqual(await page.evaluate(config=>window.peer.open(config),config),browserIdentity);
  assert.equal(await page.evaluate(({user,device})=>window.peer.status(user,device),{user:alice.user_id,device:alice.device_id}),true);
  assert.equal(await page.evaluate(({room,event})=>window.peer.decrypt(room,event),{room,event:nativeEvent}),'native fixture');
  const syncBefore=JSON.parse(await readFile(`${directory}/native/sync.json`,'utf8'));
  assert.equal(typeof syncBefore.syncToken,'string');assert.ok(syncBefore.syncToken.length>0,'durable sync token exists');
  const exited=new Promise(resolve=>worker.once('exit',resolve));worker.kill('SIGKILL');await exited;await unlink(`${directory}/native/writer.lock`);
  const offlineEvent=await page.evaluate(room=>window.peer.send(room,'offline fixture'),room);
  launchWorker();const restarted=await rpc({op:'open',directory:`${directory}/native`,baseUrl,token:alice.access_token});
  assert.notEqual(restarted.pid,native.pid);assert.equal(restarted.fingerprint,native.fingerprint);assert.equal(restarted.device,native.device);
  assert.equal(restarted.resumedSince,true,'first real sync request uses persisted since token');
  assert.equal((await rpc({op:'decrypt',room,event:browserEvent.event_id})).body,'browser fixture');
  assert.equal((await rpc({op:'decrypt',room,event:offlineEvent.event_id})).body,'offline fixture');
  assert.equal((await rpc({op:'capabilities'})).verificationApi,'undefined');
  console.log('browser trust/history and native SIGKILL/reconnect history passed; native verification API absent');
  await rpc({op:'close'});await context.close();
 });
 } finally {worker?.kill();await context?.close();await new Promise(resolve=>server.httpServer.close(resolve));await rm(directory,{recursive:true,force:true});await rm(scratch,{recursive:true,force:true});if(oldTemp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTemp;}
});
