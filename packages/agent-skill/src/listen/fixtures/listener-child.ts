import process from 'node:process';
import { runCli } from '@khala/agent-cli/cli/app';
import { openInbox } from '@khala/agent-cli/cli/inbox';
import type { AgentClientPort } from '@khala/agent-cli/cli/types';
import { decodeSessionBinding } from '@khala/contracts/delivery/index';

const [stateDirectory, bindingId] = process.argv.slice(2);
if (stateDirectory === undefined || bindingId === undefined) throw new Error('missing fixture configuration');
const decoded = decodeSessionBinding({
  v: 1,
  bindingId,
  ownerId: 'owner-1',
  agentParticipantId: 'agent-1',
  deviceId: 'device-1',
  harness: 'other-agent',
  sessionId: 'session-1',
  generation: 0,
});
if (!decoded.ok) throw new Error('invalid fixture binding');
const binding = decoded.value;
const client: AgentClientPort = {
  async connect() { return { kind: 'connected', binding, reused: true }; },
  async send(input) { return { kind: 'accepted', clientTxnId: input.clientTxnId, eventId: null }; },
  async status() {
    return { v: 1, connected: true, binding, route: 'agent_installed_listener', sourceCursor: 'source-1' };
  },
};
const abort = new AbortController();
process.once('SIGTERM', () => abort.abort());
const code = await runCli(['listen', '--binding', bindingId], {
  client,
  inbox: (heldBindingId, generation) => openInbox({
    stateDirectory,
    bindingId: heldBindingId,
    generation,
    maxPayloadBytes: 1024,
    maxSelectionEvents: 32,
  }),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  signal: abort.signal,
});
process.exitCode = code;
