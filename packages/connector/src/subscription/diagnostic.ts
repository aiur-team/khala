/** Fixed local checkpoints for a hosted subscription that cannot reach live intake. */
export type OwnerDeviceAttestationStage = 'fingerprint' | 'capability' | 'challenge_transport'
  | 'challenge_response' | 'register_transport' | 'register_response' | 'internal';

export type HostedSubscriptionDiagnostic = Readonly<{
  stage: 'local_guard' | 'mailbox_guard' | 'owner_device_guard' | 'guard_exception'
    | 'matrix_authorize' | 'matrix_read' | 'matrix_lost' | 'mailbox_http' | 'owner_device_http'
    | `owner_device_attestation_${OwnerDeviceAttestationStage}`
    | 'owner_device_capability' | 'owner_device_empty' | 'owner_device_trust_peer';
  result: 'unavailable' | 'revoked' | 'closing' | 'expired' | 'rejected' | 'gap';
  httpStatus?: number;
}>;
