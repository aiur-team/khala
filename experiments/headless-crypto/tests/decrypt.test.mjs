import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decryptWithKeyRetry} from '../src/decrypt.ts';
test('transport/plaintext/arbitrary SDK failures cannot masquerade as missing keys',async()=>{
 const transport=new Error('HTTP 503');let calls=0;
 await assert.rejects(decryptWithKeyRetry(async()=>{throw transport},async()=>{calls++},3),error=>error===transport);
 await assert.rejects(decryptWithKeyRetry(async()=>({type:'m.room.message'}),async()=>{calls++},3),/server stored plaintext/);
 assert.equal(calls,0);
 const native=new Error('bad ciphertext MAC');
 await assert.rejects(decryptWithKeyRetry(async()=>({type:'m.room.encrypted'}),async()=>{calls++;throw native},3),error=>error===native);
 assert.equal(calls,1);
});
test('only specific native missing-key errors retry and may establish withholding',async()=>{
 const missing=Object.assign(new Error("Can't find the room key to decrypt the event, withheld code: None"),{code:'GenericFailure'});
 let calls=0;
 await assert.rejects(decryptWithKeyRetry(async()=>({type:'m.room.encrypted'}),async()=>{calls++;throw missing},2,async()=>{}),/native missing room key after retry/);
 assert.equal(calls,2);
 const recovered=await decryptWithKeyRetry(async()=>({type:'m.room.encrypted'}),async()=>{if(calls++===2)throw missing;return 'decrypted';},2,async()=>{});
 assert.equal(recovered,'decrypted');
});
