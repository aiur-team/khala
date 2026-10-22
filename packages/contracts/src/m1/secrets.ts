/**
 * Client-side secret guard shared by the agent send tools and the web
 * composer. Channel content is end-to-end encrypted, so the server cannot
 * check it; each send point checks before encrypting. Patterns stay
 * conservative: a false positive blocks an ordinary message.
 */

// A value counts as a credential only if it mixes letters and digits and is
// not a bare hex string or UUID (commit SHAs, ids).
const credentialLike = (value: string) =>
  /[A-Za-z]/u.test(value) && /\d/u.test(value) && !/^[0-9a-f-]+$/iu.test(value);

const SECRET_PATTERNS: readonly (readonly [kind: string, pattern: RegExp, check?: (match: string) => boolean])[] = [
  ['private_key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/u],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{32,}/u],
  ['openai_key', /\bsk-(?:proj-|svcacct-|admin-)?([A-Za-z0-9_-]{32,})/u, credentialLike],
  ['aws_access_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/u],
  ['google_api_key', /\bAIza[A-Za-z0-9_-]{35}/u],
  // Env-style assignment such as AIUR_API_KEY=… or GH_TOKEN="…".
  ['secret_assignment', /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*["']?([A-Za-z0-9_\-+/.=]{20,})/u, credentialLike],
];

/** Returns the pattern name of the first secret found in `text`, or null. */
export function detectSecret(text: string): string | null {
  for (const [kind, pattern, check] of SECRET_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern, 'gu'))) {
      if (!check || check(match[1]!)) return kind;
    }
  }
  return null;
}
