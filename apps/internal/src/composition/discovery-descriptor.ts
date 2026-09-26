import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { InternalCommand } from '@khala/contracts/internal/command';
import { parseInternalDescriptor } from '@khala/contracts/internal/descriptor';
import {
  INTERNAL_CONNECTOR_KEY_FILE, INTERNAL_DISCOVERY_DESCRIPTOR_FILE, INTERNAL_DISCOVERY_DIRECTORY, INTERNAL_DISCOVERY_SCOPES,
  encodeInternalConnectorKey, encodeInternalDiscoveryDescriptor, isDiscoveryPrincipal,
} from '@khala/contracts/internal/discovery-descriptor';
import { isInternalCapability } from '@khala/contracts/internal/descriptor';
import { activeDescriptorPath, ensurePrivateDirectory, writePrivateFile } from '../descriptor/write';
import { DISCOVERY_ROUTES } from '../server/discovery';

// `khala internal discovery`: issues (or rotates) a discovery-only descriptor for
// the caller's own running harness session. It reads the launch's transport
// capability from `active.json` and generates a fresh Ed25519 connector key. It
// asks the running local server to register a durable discovery capability, then
// writes two separate 0600 files. Khala starts no agent process here.

export type DiscoveryIssueCommand = Extract<InternalCommand, { kind: 'discovery' }>;

export type DiscoveryIssueOutcome =
  | Readonly<{
    kind: 'issued';
    principal: string;
    generation: number;
    descriptorPath: string;
    connectorKeyPath: string;
  }>
  | Readonly<{ kind: 'failed'; code: 'not_running' | 'refused' | 'unavailable' | 'unsafe_path' | 'io_failed' }>;

const MAX_ACTIVE_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 4_096;
const TIMEOUT_MS = 10_000;

function readActive(root: string): ReturnType<typeof parseInternalDescriptor> | null {
  const target = activeDescriptorPath(root);
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stats = fs.fstatSync(descriptor);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stats.isFile() || (stats.mode & 0o077) !== 0 || (uid !== null && stats.uid !== uid) || stats.size > MAX_ACTIVE_BYTES) return null;
    return parseInternalDescriptor(fs.readFileSync(descriptor, 'utf8'));
  } catch {
    return null;
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function issueDiscoveryDescriptor(input: Readonly<{
  root: string;
  command: DiscoveryIssueCommand;
  fetch?: typeof fetch;
}>): Promise<DiscoveryIssueOutcome> {
  const active = readActive(input.root);
  if (!active?.ok) return { kind: 'failed', code: 'not_running' };
  const { origin, transportCapability } = active.value;

  const keys = generateKeyPairSync('ed25519');
  const publicJwk = keys.publicKey.export({ format: 'jwk' });
  const privateJwk = keys.privateKey.export({ format: 'jwk' });
  if (typeof publicJwk.x !== 'string' || typeof privateJwk.d !== 'string') return { kind: 'failed', code: 'unavailable' };

  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(new URL(DISCOVERY_ROUTES.issue.path, origin), {
      method: 'POST',
      headers: { authorization: `Bearer ${transportCapability}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        harness: input.command.harness,
        sessionId: input.command.sessionId,
        displayLabel: input.command.displayLabel,
        workspaceLabel: input.command.workspaceLabel,
        proofPublicKey: publicJwk.x,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { kind: 'failed', code: 'unavailable' };
  }
  if (response.status !== 201) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'failed', code: response.status === 401 || response.status === 403 || response.status === 409 ? 'refused' : 'unavailable' };
  }
  let issued: Record<string, unknown>;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return { kind: 'failed', code: 'unavailable' };
    issued = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { kind: 'failed', code: 'unavailable' };
  }
  const { principal, generation, discoveryCapability } = issued;
  if (!isDiscoveryPrincipal(principal) || !Number.isSafeInteger(generation) || (generation as number) < 1
    || !isInternalCapability(discoveryCapability) || discoveryCapability === transportCapability) {
    return { kind: 'failed', code: 'unavailable' };
  }

  const directory = path.join(input.root, INTERNAL_DISCOVERY_DIRECTORY, principal);
  try {
    ensurePrivateDirectory(path.join(input.root, INTERNAL_DISCOVERY_DIRECTORY));
    ensurePrivateDirectory(directory);
    // Separate files: the descriptor alone can never sign a connector exchange proof.
    writePrivateFile(directory, INTERNAL_CONNECTOR_KEY_FILE, encodeInternalConnectorKey({
      v: 1, kind: 'connector_proof_key', principal, generation: generation as number,
      publicKey: publicJwk.x, privateKey: privateJwk.d,
    }));
    writePrivateFile(directory, INTERNAL_DISCOVERY_DESCRIPTOR_FILE, encodeInternalDiscoveryDescriptor({
      v: 1, kind: 'discovery', principal, generation: generation as number, discoveryCapability, scopes: INTERNAL_DISCOVERY_SCOPES,
    }));
  } catch (error) {
    return { kind: 'failed', code: (error as { code?: string }).code === 'unsafe_path' ? 'unsafe_path' : 'io_failed' };
  }
  return {
    kind: 'issued',
    principal,
    generation: generation as number,
    descriptorPath: path.join(directory, INTERNAL_DISCOVERY_DESCRIPTOR_FILE),
    connectorKeyPath: path.join(directory, INTERNAL_CONNECTOR_KEY_FILE),
  };
}
