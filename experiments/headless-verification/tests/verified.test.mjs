import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {preview} from 'vite';
import {proof} from '../../backend/check.ts';
import {cleanupWorkers} from '../src/shutdown.ts';

test('public SDK headless runtime withholds before verify/after revoke and persists verified identity/history', {timeout:240000},async()=>{
 await mkdir('stores',{recursive:true});const directory=resolve(await mkdtemp('stores/live-'));
 const scratch=await mkdtemp(`${homedir()}/.cache/khala-verify-`);const oldTemp=process.env.TMPDIR;process.env.TMPDIR=scratch;
 const server=await preview({preview:{host:'127.0.0.1',port:0}});const children=new Set();let sequence=0;
 const start=()=>{const child=fork('src/worker.ts',[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,TMPDIR:scratch}});children.add(child);return child;};
 const rpc=(child,op,args=[],extras={})=>new Promise((yes,no)=>{
  const id=++sequence;const timer=setTimeout(()=>{child.off('message',receive);no(new Error(`${op} deadline`));},35000);
  const receive=reply=>{if(reply.id!==id)return;clearTimeout(timer);child.off('message',receive);reply.error?no(new Error(reply.error)):yes(reply.result);};
  child.on('message',receive);child.send({op,args,id,...extras});
 });
 const close=async child=>{const exited=new Promise(resolve=>child.once('exit',resolve));await rpc(child,'close');await exited;children.delete(child);};
 try {await proof(async({baseUrl,alice,bob})=>{
  const api=async(path,token,body)=>{const r=await fetch(baseUrl+'/_matrix/client/v3'+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,`HTTP ${r.status}`);return r.json();};
  const {room_id:room}=await api('/createRoom',alice.access_token,{visibility:'private',invite:[bob.user_id],initial_state:[{type:'m.room.encryption',state_key:'',content:{algorithm:'m.megolm.v1.aes-sha2'}}]});
  await api(`/join/${encodeURIComponent(room)}`,bob.access_token,{});
  const config=user=>({baseUrl,userId:user.user_id,deviceId:user.device_id,accessToken:user.access_token});
  const a=start();let b=start();
  const open=(child,name,user)=>rpc(child,'open',[],{profile:`${directory}/${name}`,url:server.resolvedUrls.local[0],config:config(user)});
  const ak=await open(a,'alice',alice);const bk=await open(b,'bob',bob);
  const withheld=await rpc(a,'send',[room,'unverified fixture']);
  assert.equal((await rpc(b,'decrypt',[room,withheld.event_id,10])).status,'missing-key');
  await assert.rejects(rpc(a,'trust',[bob.user_id,bob.device_id,'wrong']),/fingerprint mismatch/);
  assert.equal(await rpc(a,'trust',[bob.user_id,bob.device_id,bk.keys.ed25519]),true);
  assert.equal(await rpc(b,'trust',[alice.user_id,alice.device_id,ak.keys.ed25519]),true);
  await rpc(a,'rotate',[room]);
  const allowed=await rpc(a,'send',[room,'verified fixture']);
  assert.deepEqual(await rpc(b,'decrypt',[room,allowed.event_id]),{status:'decrypted',body:'verified fixture'});
  const reverse=await rpc(b,'send',[room,'reverse verified fixture']);
  assert.equal((await rpc(a,'decrypt',[room,reverse.event_id])).body,'reverse verified fixture');
  await close(b);b=start();const restarted=await open(b,'bob',bob);
  assert.notEqual(restarted.pid,bk.pid);assert.deepEqual(restarted.keys,bk.keys);
  assert.equal(await rpc(b,'trusted',[alice.user_id,alice.device_id]),true);
  assert.equal((await rpc(b,'decrypt',[room,allowed.event_id])).body,'verified fixture');
  assert.equal(await rpc(a,'trust',[bob.user_id,bob.device_id,bk.keys.ed25519,false]),false);
  await rpc(a,'rotate',[room]);
  const revoked=await rpc(a,'send',[room,'revoked fixture']);
  assert.equal((await rpc(b,'decrypt',[room,revoked.event_id,10])).status,'missing-key');
  console.log('headless public SDK: withheld before verification; symmetric verified exchange; persisted identity/trust/history; revoked recipient withheld');
  await close(a);await close(b);
 });}finally{
  await cleanupWorkers(children,async()=>{
   try{await new Promise(resolve=>server.httpServer.close(resolve));}
   finally{
    try{
     const removals=await Promise.allSettled([rm(directory,{recursive:true,force:true}),rm(scratch,{recursive:true,force:true})]);
     const failure=removals.find(result=>result.status==='rejected');
     if(failure?.status==='rejected')throw failure.reason;
    }
    finally{if(oldTemp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTemp;}
   }
  });
 }
});
