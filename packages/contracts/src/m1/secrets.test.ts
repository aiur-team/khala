import { describe, expect, it } from 'vitest';
import { detectSecret } from './secrets';

// Built by concatenation so this file does not itself look like it leaks keys.
const tail = (n: number) => 'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xYz'.repeat(4).slice(0, n);

describe('detectSecret', () => {
  it.each([
    ['github_token', `token is ${'ghp_' + tail(36)}`],
    ['github_token', 'gho_' + tail(36)],
    ['github_token', 'ghs_' + tail(40)],
    ['github_token', 'github_pat_' + tail(22) + '_' + tail(59)],
    ['anthropic_key', `export ANTHROPIC=${'sk-ant-api03-' + tail(90)}`],
    ['openai_key', 'sk-' + tail(48)],
    ['openai_key', 'sk-proj-' + tail(100)],
    ['aws_access_key', 'aws AKIA' + 'IOSFODNN7EXAMPLE'],
    ['slack_token', 'xoxb-' + '1234567890-1234567890123-' + tail(24)],
    ['google_api_key', 'AIza' + tail(35)],
    ['private_key', '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIE...'],
    ['private_key', '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'],
    ['private_key', '-----BEGIN ' + 'PRIVATE KEY-----'],
    ['secret_assignment', 'AIUR_API_KEY=' + tail(32)],
    ['secret_assignment', 'set GH_TOKEN="' + tail(24) + '" first'],
    ['secret_assignment', 'CLIENT_SECRET = ' + tail(30)],
  ])('flags %s', (kind, text) => {
    expect(detectSecret(text)).toBe(kind);
  });

  it.each([
    'Pushed 3f2a9c1e8b7d6a5f4e3c2b1a0f9e8d7c6b5a4f3e to main; PR #1293 is green.',
    'Session 8f150525-f29c-4409-addf-25c28c19366d joined.',
    'The task-based scheduler uses a risk-assessment and long-running-job approach.',
    'sk-learn is a library; ask-anthropic-for-help-with-the-docs-please-thanks',
    'Set AIUR_API_KEY=$AIUR_API_KEY in your shell, or TOKEN=<your-token-here>.',
    'CACHE_KEY=3f2a9c1e8b7d6a5f4e3c2b1a0f9e8d7c6b5a4f3e',
    'GITHUB_TOKEN=placeholder_value_for_docs_only',
    'Use the ghp_ prefix check and the AKIA prefix check.',
    'The public key is -----BEGIN PUBLIC KEY-----',
    'xoxb- tokens start with xoxb-',
    '',
  ])('allows %j', text => {
    expect(detectSecret(text)).toBeNull();
  });
});
