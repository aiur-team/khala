import {test} from 'node:test';
import assert from 'node:assert/strict';
import native from '@matrix-org/matrix-sdk-crypto-nodejs';
import {readFile} from 'node:fs/promises';
test('native0.6.6 has verified-only policy but no public independent-device trust setter',()=>{
 const settings=new native.EncryptionSettings();settings.sharingStrategy=native.CollectStrategy.OnlyTrustedDevices;
 assert.equal(settings.sharingStrategy,native.CollectStrategy.OnlyTrustedDevices);
 assert.equal(typeof native.OlmMachine.prototype.getDevice,'function');
 assert.equal(typeof native.Device.prototype.isVerified,'function');
 assert.equal(typeof native.Device.prototype.setLocalTrust,'undefined');
 assert.equal(typeof native.OlmMachine.prototype.setDeviceVerified,'undefined');
});
test('documented pure-Node Matrix JS Rust crypto store is ephemeral',async()=>{
 const readme=await readFile(new URL('../node_modules/matrix-js-sdk/README.md',import.meta.url),'utf8');
 assert.match(readme,/useIndexedDB: false/);assert.match(readme,/ephemeral in-memory store/);
});
