import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {chromium} from 'playwright';
import {preview} from 'vite';
import {proof} from '../../backend/check.ts';

test('trusted independent browser peer old history survives process restart, real crypto loss refuses old history', {timeout:240000},async()=>{
 await mkdir('profiles',{recursive:true});
 const root=await mkdtemp('profiles/live-');const scratch=await mkdtemp(`${homedir()}/.cache/khala-live-`);
 const oldTemp=process.env.TMPDIR;process.env.TMPDIR=scratch;
 const server=await preview({preview:{host:'127.0.0.1',port:0}});
 let aliceContext,bobContext;
 const launch=async(name)=>{
  const context=await chromium.launchPersistentContext(`${root}/${name}`,{executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',env:{...process.env,TMPDIR:scratch},headless:true,args:['--no-sandbox']});
  const page=await context.newPage();await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>!!window.peer);return {context,page};
 };
 try {await proof(async({baseUrl,alice,bob})=>{
  const api=async(path,token,body)=>{const r=await fetch(baseUrl+'/_matrix/client/v3'+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok);return r.json();};
  const {room_id:room}=await api('/createRoom',alice.access_token,{visibility:'private',invite:[bob.user_id],initial_state:[{type:'m.room.encryption',state_key:'',content:{algorithm:'m.megolm.v1.aes-sha2'}}]});
  await api(`/join/${encodeURIComponent(room)}`,bob.access_token,{});
  const a=await launch('alice');aliceContext=a.context;const b=await launch('bob');bobContext=b.context;
  const config=user=>({baseUrl,userId:user.user_id,deviceId:user.device_id,accessToken:user.access_token});
  const ak=await a.page.evaluate(c=>window.peer.open(c),config(alice));const bk=await b.page.evaluate(c=>window.peer.open(c),config(bob));
  await assert.rejects(a.page.evaluate(({user,device})=>window.peer.trust(user,device,'wrong'),{user:bob.user_id,device:bob.device_id}),/fingerprint mismatch/);
  assert.equal(await a.page.evaluate(({user,device,fingerprint})=>window.peer.trust(user,device,fingerprint),{user:bob.user_id,device:bob.device_id,fingerprint:bk.ed25519}),true);
  assert.equal(await b.page.evaluate(({user,device,fingerprint})=>window.peer.trust(user,device,fingerprint),{user:alice.user_id,device:alice.device_id,fingerprint:ak.ed25519}),true);
  await a.page.evaluate(room=>window.peer.observe(room),room);
  await b.page.evaluate(room=>window.peer.observe(room),room);
  const {event_id:event}=await a.page.evaluate(room=>window.peer.send(room,'trusted disposable fixture'),room);
  assert.equal(await b.page.evaluate(({room,event})=>window.peer.decrypt(room,event),{room,event}),'trusted disposable fixture');
  await b.page.waitForFunction(event=>window.peer.snapshot().some(entry=>entry.eventId===event&&entry.body==='trusted disposable fixture'&&!entry.undecryptable),event);
  assert.ok((await a.page.evaluate(()=>window.peer.snapshot())).some(entry=>entry.eventId===event),'real local echo reconciles to acknowledged event');
  assert.ok(await a.page.evaluate(()=>window.peer.paginate())>0,'real SDK timeline pagination');
  const observed=await a.page.evaluate(()=>window.peer.snapshot());await a.page.evaluate(()=>window.peer.disposeObserver());
  await a.page.evaluate(room=>window.peer.send(room,'disposed observer fixture'),room);
  assert.deepEqual(await a.page.evaluate(()=>window.peer.snapshot()),observed,'disposed real SDK observer stays unchanged');
  const browserPid=async(context)=>(await (await context.browser().newBrowserCDPSession()).send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser').id;
  const oldPid=await browserPid(bobContext);await bobContext.close();
  const restarted=await launch('bob');bobContext=restarted.context;
  assert.notEqual(await browserPid(bobContext),oldPid);
  assert.deepEqual(await restarted.page.evaluate(c=>window.peer.open(c),config(bob)),bk);
  assert.equal(await restarted.page.evaluate(({user,device})=>window.peer.status(user,device),{user:alice.user_id,device:alice.device_id}),true);
  assert.equal(await restarted.page.evaluate(({room,event})=>window.peer.decrypt(room,event),{room,event}),'trusted disposable fixture');
  await aliceContext.close();await bobContext.close();
  const lost=await launch('bob');bobContext=lost.context;
  await lost.page.evaluate(async()=>{for(const db of await indexedDB.databases())await new Promise((yes,no)=>{const r=indexedDB.deleteDatabase(db.name);r.onsuccess=yes;r.onerror=no;r.onblocked=()=>no(new Error('blocked'));});});
  const changed=await lost.page.evaluate(c=>window.peer.open(c),config(bob));assert.notDeepEqual(changed,bk);
  await assert.rejects(lost.page.evaluate(({room,event})=>window.peer.decrypt(room,event),{room,event}),/missing peer room key/);
  console.log('trusted peer old event survives distinct browser PID; deleted IndexedDB cannot decrypt old event');
  await bobContext.close();
 });}finally{await aliceContext?.close();await bobContext?.close();await new Promise(resolve=>server.httpServer.close(resolve));await rm(root,{recursive:true,force:true});await rm(scratch,{recursive:true,force:true});if(oldTemp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTemp;}
});
