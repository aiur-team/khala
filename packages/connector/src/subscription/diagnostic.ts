/** Fixed local checkpoints for a hosted subscription that cannot reach live intake. */
export type OwnerDeviceAttestationStage = 'fingerprint' | 'capability' | 'challenge_transport'
  | 'challenge_response' | 'register_transport' | 'register_response' | 'internal';

export type HostedSubscriptionDiagnostic = Readonly<{
  stage: 'local_guard' | 'mailbox_guard' | 'owner_device_guard' | 'guard_exception'
    | 'matrix_authorize' | 'matrix_read' | 'matrix_lost' | 'mailbox_http' | 'owner_device_http'
    | `owner_device_attestation_${OwnerDeviceAttestationStage}`
    | 'owner_device_capability' | 'owner_device_empty' | 'owner_device_trust_peer'
    | 'matrix_read_closed' | 'matrix_read_bridge' | 'matrix_read_members'
    | 'matrix_read_participants' | 'matrix_read_processing' | 'matrix_read_missing_keys'
    | 'matrix_read_names' | 'matrix_read_callback';
  result: 'unavailable' | 'revoked' | 'closing' | 'expired' | 'rejected' | 'gap';
  httpStatus?: number;
}>;
