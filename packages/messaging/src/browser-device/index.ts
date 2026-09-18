// Public surface of the browser device lifecycle (KHA-111). Implements the
// `DevicePort` contract from `@khala/contracts/messaging`. The substrate engine is
// injected; nothing here selects or imports a messaging SDK.

export { type BrowserDeviceService, type EngineContext, createBrowserDeviceService } from './service';
export {
  type BrowserDeviceDependencies, type CredentialResolution, type CredentialSource, type CryptoStore, type CryptoStoreFactory,
  type DeviceEngine, type DeviceEngineFactory, type EngineOpenInput, type EngineSignal, type IdentityMarker,
  type IdentityMarkerStore, type LocalIdentity, type SubstrateSession, DEFAULT_LOCK_WAIT_MS,
} from './lifecycle';
export {
  type LockAcquisition, type LockManagerLike, type OwnerLease, type OwnerLockProvider, createWebLockProvider, lockName,
} from './ownership';
export { createIndexedDbMarkerStore, createIndexedDbStoreFactory, cryptoStoreName } from './storage';
