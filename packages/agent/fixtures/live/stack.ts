import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';

let root = path.dirname(fileURLToPath(import.meta.url));
while (!existsSync(path.join(root, 'pnpm-workspace.yaml'))) {
  const parent = path.dirname(root);
  if (parent === root) throw new Error('workspace_root_unavailable');
  root = parent;
}
export const repoRoot = root;
export function readStack(): { homeserver: string; services: Record<string, string> } {
  const output = execFileSync('pnpm', ['stack:status'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(root, '.khala-local/certs/tls.crt') } });
  const json = output.split('\n').find(line => line.startsWith('{'));
  if (!json) throw new Error('stack_status_unavailable');
  const status = JSON.parse(json);
  if (status.services.synapse !== 'up' || status.services.gateway !== 'up') throw new Error('stack_down');
  return status;
}
export function registrationSecret(): string {
  const state = JSON.parse(readFileSync(path.join(root, '.khala-local/state.json'), 'utf8'));
  const secret = state.secrets?.registrationSharedSecret;
  if (typeof secret !== 'string' || !secret) throw new Error('registration_secret_unavailable');
  return secret;
}
async function request(base: string, endpoint: string, body?: unknown) {
  const res = await fetch(`${base}${endpoint}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`matrix_request_failed:${res.status}:${endpoint}`);
  return res.json();
}
export async function registerUser(prefix: string): Promise<{ userId: string; password: string }> {
  const { homeserver } = readStack();
  const username = `${prefix}_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const { nonce } = await request(homeserver, '/_synapse/admin/v1/register');
  const mac = createHmac('sha1', registrationSecret()).update(`${nonce}\0${username}\0${password}\0notadmin`).digest('hex');
  const registered = await request(homeserver, '/_synapse/admin/v1/register', { nonce, username, password, admin: false, mac });
  return { userId: registered.user_id, password };
}
export async function login(userId: string, password: string, deviceId: string): Promise<AgentCredentials> {
  const { homeserver } = readStack();
  const result = await request(homeserver, '/_matrix/client/v3/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password, device_id: deviceId });
  return { homeserver, userId: result.user_id, accessToken: result.access_token, deviceId: result.device_id, roomId: '' };
}
