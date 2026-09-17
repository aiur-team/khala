import { createClient, MatrixEvent } from 'matrix-js-sdk';
let client: ReturnType<typeof createClient>;
const delay = () => new Promise(resolve => setTimeout(resolve, 200));
Object.assign(window, { peer: {
  async open(config: {baseUrl:string;userId:string;accessToken:string;deviceId:string}) {
    client = createClient(config);
    await client.initRustCrypto({useIndexedDB:true, cryptoDatabasePrefix:'independent-peer'});
    client.getCrypto()!.globalBlacklistUnverifiedDevices = true;
    await client.startClient({initialSyncLimit:50});
    for(let i=0;i<150;i++){ if(client.getSyncState()==='PREPARED'||client.getSyncState()==='SYNCING') return client.getCrypto()!.getOwnDeviceKeys();await delay(); }
    throw new Error('browser sync timeout');
  },
  async trust(user:string,device:string,fingerprint:string) {
    const devices=await client.getCrypto()!.getUserDeviceInfo([user],true);
    if(devices.get(user)?.get(device)?.getFingerprint()!==fingerprint) throw new Error('out-of-band fingerprint mismatch');
    await client.getCrypto()!.setDeviceVerified(user,device,true);
    return (await client.getCrypto()!.getDeviceVerificationStatus(user,device))!.isVerified();
  },
  async status(user:string,device:string){return (await client.getCrypto()!.getDeviceVerificationStatus(user,device))?.isVerified()??false;},
  async send(room:string,body:string){return client.sendTextMessage(room,body);},
  async discard(room:string){await client.getCrypto()!.forceDiscardSession(room);},
  async decrypt(room:string,eventId:string) {
    const raw=await client.fetchRoomEvent(room,eventId);
    if(raw.type!=='m.room.encrypted') throw new Error('server stored plaintext');
    for(let i=0;i<100;i++){
      const event=new MatrixEvent(raw);
      await client.decryptEventIfNeeded(event);
      if(!event.isDecryptionFailure()) return event.getContent().body;
      await delay();
    }
    throw new Error('missing peer room key');
  },
  close(){client.stopClient();},
} });
