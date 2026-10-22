/**
 * The path a sign-in began from, kept in this tab so the landing page's
 * "Sign-in expired. Try again" can return there when the callback fails
 * (the server drops the return path with a rejected login).
 */
export const SIGN_IN_RETURN_KEY = 'khala.signInReturn';

export function rememberSignInReturn(path: string): void {
  try { sessionStorage.setItem(SIGN_IN_RETURN_KEY, path); } catch { /* Storage can be blocked; retry then opens the channel list. */ }
}
