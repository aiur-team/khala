/** Fixed local checkpoints for a hosted subscription that cannot reach live intake. */
export type HostedSubscriptionDiagnostic = Readonly<{
  stage: 'local_guard' | 'mailbox_guard' | 'owner_device_guard' | 'guard_exception'
    | 'matrix_authorize' | 'matrix_read' | 'matrix_lost' | 'mailbox_http' | 'owner_device_http';
  result: 'unavailable' | 'revoked' | 'closing' | 'expired' | 'rejected' | 'gap';
  httpStatus?: number;
}>;
