import type { MatrixClient } from 'matrix-js-sdk';
export { fixtureReviewPort, type ReviewPort } from '../../fixtures/scenario';
// The composition owner injects the sole lifecycle-managed client. Presentation
// receives projected rows, never creates a crypto store/client or grants approval.
export type ClientLease = { readonly client: MatrixClient; readonly dispose: () => void };
export type AuthenticationPort = { signInAndReturn(invitation: string): Promise<string> };
export function fixtureAuthentication(): AuthenticationPort {
  return { async signInAndReturn(invitation) { return invitation; } };
}
