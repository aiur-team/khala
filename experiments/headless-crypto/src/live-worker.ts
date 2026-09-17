import bot from 'matrix-bot-sdk';
import { createRequire } from 'node:module';
import { acquireStore } from './store';
import { decryptWithKeyRetry } from './decrypt';
const require=createRequire(import.meta.url);
const native=require(require.resolve('@matrix-org/matrix-sdk-crypto-nodejs',{paths:[require.resolve('matrix-bot-sdk')]}));
bot.LogService.setLevel(bot.LogLevel.ERROR);
let client: InstanceType<typeof bot.MatrixClient>;
let release:()=>Promise<void>;
class ObservedClient extends bot.MatrixClient {
  firstSince: string | undefined;
  protected override doSync(token:string) { if(this.firstSince===undefined)this.firstSince=token || '';return super.doSync(token); }
}
process.on('message',async (message:any)=>{
 try {
  let result:any;
  if(message.op==='open'){
   release=await acquireStore(message.directory);
   const syncStore=new bot.SimpleFsStorageProvider(`${message.directory}/sync.json`);
   const priorToken=await syncStore.getSyncToken();
   client=new ObservedClient(message.baseUrl,message.token,syncStore,new bot.RustSdkCryptoStorageProvider(message.directory,native.StoreType.Sqlite));
   await client.start();
   result={pid:process.pid,device:client.crypto.clientDeviceId,fingerprint:client.crypto.clientDeviceEd25519,resumedSince:!!priorToken&&(client as ObservedClient).firstSince===priorToken};
  } else if(message.op==='send') result=await client.sendText(message.room,message.body);
  else if(message.op==='decrypt') {
   result=await decryptWithKeyRetry(
    ()=>client.getRawEvent(message.room,message.event),
    async event=>(await client.crypto.decryptRoomEvent(new bot.EncryptedRoomEvent(event),message.room)).content,
    message.attempts??100,
   );
  } else if(message.op==='capabilities') result={verificationApi:typeof (client.crypto as any).setDeviceVerified};
  else if(message.op==='close'){client.stop();await release();process.send?.({id:message.id,result:true});process.exit(0);}
  process.send?.({id:message.id,result});
 } catch(error) {process.send?.({id:message.id,error:error instanceof Error?error.message:'operation failed'});}
});
