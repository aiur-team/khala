import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BindingId, EventRef, ReleaseId } from '../../../../packages/contracts/src/delivery/index.ts';
import { openInbox } from '../../../../packages/agent-cli/src/cli/inbox.ts';
import { MAX_SEND_BYTES } from '../../../../packages/agent-cli/src/cli/send.ts';
import {
  encodeMessageContent, encodeReleasePayload, sha256Digest,
} from '../../../../packages/policy/src/release/codec.ts';

// Khala side of the live proof. Message bodies arrive on stdin, never in argv.
//
//   khala.ts setup <fixture-dir> <run-label>
//   khala.ts enqueue <fixture-dir> < [{"channel": "...", "author": "...", "body": "..."}, ...]
//   khala.ts status <fixture-dir>
//
// `enqueue` builds each release with the policy package's canonical encoder
// and appends it to the same durable inbox that the product MCP server reads.
const [command, dirArgument, label] = process.argv.slice(2);
if (!command || !dirArgument) throw new Error('usage: khala.ts <setup|enqueue|status> <fixture-dir> [run-label]');
const fixtureDir = resolve(dirArgument);
const logPath = join(fixtureDir, 'events.jsonl');

async function log(event: Record<string, unknown>): Promise<void> {
  await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

async function binding() {
  return JSON.parse(await readFile(join(fixtureDir, 'binding.json'), 'utf8'));
}

async function inbox() {
  const held = await binding();
  return openInbox({
    stateDirectory: join(fixtureDir, 'state'), bindingId: held.bindingId, generation: held.generation,
    maxPayloadBytes: MAX_SEND_BYTES, maxSelectionEvents: 32,
  });
}

async function digest(bytes: Uint8Array): Promise<string> {
  const result = await sha256Digest(bytes);
  if (!result.ok) throw new Error('digest unavailable');
  return result.digest;
}

if (command === 'setup') {
  if (!label) throw new Error('setup needs a run label');
  await mkdir(join(fixtureDir, 'state'), { recursive: true, mode: 0o700 });
  const held = {
    v: 1,
    bindingId: `binding-e2e-${label}`,
    ownerId: 'owner-e2e',
    agentParticipantId: 'participant-codex-agent',
    deviceId: 'device-codex-e2e',
    harness: 'codex',
    sessionId: `session-e2e-${label}`,
    generation: 1,
  };
  await writeFile(join(fixtureDir, 'binding.json'), `${JSON.stringify(held)}\n`, { mode: 0o600 });
  await log({ event: 'setup', label, binding: held });
} else if (command === 'enqueue') {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const messages = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { channel: string; author: string; body: string }[];
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('stdin must be a nonempty message array');
  const held = await binding();
  const target = await inbox();
  for (const message of messages) {
    const content = { v: 1, kind: 'text', body: message.body } as const;
    const ref: EventRef = {
      v: 1,
      roomId: message.channel as EventRef['roomId'],
      eventId: `event-${randomUUID()}` as EventRef['eventId'],
      authorParticipantId: message.author as EventRef['authorParticipantId'],
      authorDeviceId: `device-${message.author}` as EventRef['authorDeviceId'],
      contentDigest: await digest(encodeMessageContent(content)),
    };
    const releaseId = `release-${randomUUID()}` as ReleaseId;
    const encoded = encodeReleasePayload({
      releaseId, bindingId: held.bindingId as BindingId, generation: held.generation, policyVersion: 1,
      items: [{ ref, content }],
    });
    if (!encoded.ok) throw new Error(`release encoding refused ${encoded.field}`);
    const payloadDigest = await digest(encoded.bytes);
    const outcome = await target.enqueue({
      v: 1, releaseId, bindingId: held.bindingId, generation: held.generation, events: [ref],
      payloadDigest, payload: encoded.bytes, receivedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    await log({
      event: 'enqueued', outcome, releaseId, payloadDigest, payloadBytes: encoded.bytes.byteLength,
      channel: message.channel, author: message.author, body: message.body,
    });
  }
} else if (command === 'status') {
  const status = await (await inbox()).status();
  await log({ event: 'inbox_status', status });
  console.log(JSON.stringify(status));
} else {
  throw new Error(`unknown command ${command}`);
}
