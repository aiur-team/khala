import {createClient,MatrixEvent} from 'matrix-js-sdk';
import {DecryptionFailureCode} from 'matrix-js-sdk/lib/crypto-api/index.js';

let client:ReturnType<typeof createClient>;
const delay=()=>new Promise(resolve=>setTimeout(resolve,200));
const missingCodes=new Set([
 DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID,
 DecryptionFailureCode.MEGOLM_KEY_WITHHELD,
 DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE,
]);
const runtime={
 async open(config:{baseUrl:string;userId:string;deviceId:string;accessToken:string}){
  client=createClient(config);
  await client.initRustCrypto({useIndexedDB:true,cryptoDatabasePrefix:'owner-local'});
  const keys=await client.getCrypto()!.getOwnDeviceKeys();
  const saved=localStorage.getItem('identity');
  if(saved&&saved!==JSON.stringify(keys)){client.stopClient();throw new Error('owner crypto identity lost');}
  localStorage.setItem('identity',JSON.stringify(keys));
  client.getCrypto()!.globalBlacklistUnverifiedDevices=true;
  await client.startClient({initialSyncLimit:50,pollTimeout:1000});
  for(let i=0;i<150;i++){
   if(client.getSyncState()==='PREPARED'||client.getSyncState()==='SYNCING')return keys;
   await delay();
  }
  throw new Error('headless sync deadline');
 },
 async trust(user:string,device:string,fingerprint:string,verified=true){
  const devices=await client.getCrypto()!.getUserDeviceInfo([user],true);
  if(devices.get(user)?.get(device)?.getFingerprint()!==fingerprint)throw new Error('out-of-band fingerprint mismatch');
  await client.getCrypto()!.setDeviceVerified(user,device,verified);
  return runtime.trusted(user,device);
 },
 async trusted(user:string,device:string){return (await client.getCrypto()!.getDeviceVerificationStatus(user,device))?.isVerified()??false;},
 async send(room:string,body:string){return client.sendTextMessage(room,body);},
 async rotate(room:string){await client.getCrypto()!.forceDiscardSession(room);},
 async decrypt(room:string,id:string,attempts=100){
  const raw=await client.fetchRoomEvent(room,id);
  if(raw.type!=='m.room.encrypted')throw new Error('ciphertext required');
  let reason:DecryptionFailureCode|null=null;
  for(let i=0;i<attempts;i++){
   const event=new MatrixEvent(raw);
   await client.decryptEventIfNeeded(event);
   if(!event.isDecryptionFailure())return {status:'decrypted',body:event.getContent().body};
   reason=event.decryptionFailureReason;
   if(!reason||!missingCodes.has(reason))throw new Error(`unexpected decryption failure: ${reason}`);
   await delay();
  }
  return {status:'missing-key',reason};
 },
 close(){client.stopClient();},
};
Object.assign(window,{runtime});
