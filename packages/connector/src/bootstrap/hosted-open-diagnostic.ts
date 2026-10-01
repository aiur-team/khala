import type { StorageErrorCode } from '../storage/errors.js';

/** Fixed local checkpoints for opening a hosted connector. */
export type HostedOpenDiagnostic = Readonly<{
  stage: 'browser_preflight' | 'state_storage' | 'trust_storage' | 'bootstrap_persistence'
    | 'binding_recovery' | 'device_resume' | 'intake_start' | 'subscription_start'
    | 'review_resume' | 'connector_bootstrap' | 'matrix_writer_active'
    | 'matrix_startup_retry' | 'matrix_startup_blocked';
  result: 'unavailable';
  errorCode?: StorageErrorCode;
}> | Readonly<{
  stage: 'matrix_writer_recovered';
  result: 'recovered';
  errorCode?: never;
}>;
