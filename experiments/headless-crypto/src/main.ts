import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import bot from 'matrix-bot-sdk';
const { RustSdkCryptoStorageProvider } = bot;
const require = createRequire(import.meta.url);
// Resolve exactly the native binding used by the installed bot SDK.
const native = require(require.resolve('@matrix-org/matrix-sdk-crypto-nodejs', { paths: [require.resolve('matrix-bot-sdk')] }));
const [directory, operation] = process.argv.slice(2);
if (!directory) throw new Error('disposable store directory required');
const { acquireStore, checkIdentity } = await import('./store');
const release = await acquireStore(directory);
let machine: any;
try {
const provider = new RustSdkCryptoStorageProvider(directory, native.StoreType.Sqlite);
await provider.setDeviceId('DISPOSABLE');
machine = await native.OlmMachine.initialize(new native.UserId('@proof:localhost'), new native.DeviceId(await provider.getDeviceId()), directory, '', native.StoreType.Sqlite);
const identity = { ed25519: machine.identityKeys.ed25519.toBase64(), curve25519: machine.identityKeys.curve25519.toBase64() };
await checkIdentity(directory, identity, operation === 'create');
const room = new native.RoomId('!proof:localhost');
if (operation === 'create') {
  await machine.shareRoomKey(room, [], new native.EncryptionSettings());
  const content = JSON.parse(await machine.encryptRoomEvent(room, 'm.room.message', JSON.stringify({msgtype:'m.text',body:'disposable fixture'})));
  await writeFile(`${directory}/event.json`, JSON.stringify({type:'m.room.encrypted',content,sender:'@proof:localhost',event_id:'$disposable',origin_server_ts:1}), {mode:0o600});
}
const event = await readFile(`${directory}/event.json`, 'utf8');
const decrypted = JSON.parse((await machine.decryptRoomEvent(event, room)).event);
if (decrypted.content.body !== 'disposable fixture') throw new Error('old event did not decrypt');
console.log(JSON.stringify({pid:process.pid,identity,decrypted:true,device:await provider.getDeviceId()}));
if (operation === 'hold') await new Promise(() => {});
} finally { machine?.close(); await release(); }
