// Shared by `khala channels list`, `khala agents list`, and their MCP tools, so
// both surfaces print the identical strictly decoded projection. Nothing a port
// returns reaches output without passing a closed decoder here.

import type { BindingId } from '@khala/contracts/delivery/index';
import { decodeChannelListQuery, decodeChannelListingPage } from '@khala/contracts/messaging/index';
import type { AgentClientPort, AgentStatus } from '../types.js';
import { plainObject, validBindingArgument, validIdentifier } from '../validation.js';
import {
  AGENT_CONNECTIONS, CHANNEL_LIST_REFUSAL_CODES, MAX_AGENT_DISPLAY_NAME_BYTES, MAX_CHANNEL_AGENTS,
  type AgentConnection, type AgentListOutput, type ChannelAgent, type ChannelListInput, type ChannelListOutput,
  type ChannelListRefusalCode, type ListingFailure,
} from './types.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f؜​‎‏‪-‮⁠⁦-⁩﻿]/gu;

export class ChannelListingService {
  readonly #client: AgentClientPort;
  constructor(client: AgentClientPort) { this.#client = client; }

  async listChannels(input: ChannelListInput, signal?: AbortSignal): Promise<ChannelListOutput> {
    let result: unknown;
    try { result = await this.#client.listChannels(input, signal); } catch { return failure('unavailable'); }
    if (!plainObject(result)) return failure('unavailable');
    if (result.kind === 'refused' && typeof result.code === 'string'
      && (CHANNEL_LIST_REFUSAL_CODES as readonly string[]).includes(result.code)) {
      return failure(result.code as ChannelListRefusalCode);
    }
    if (result.kind !== 'listed') return failure('unavailable');
    // Server-only fields such as a Matrix roomId, roster, or activity fail the
    // closed contract decoder and are never forwarded.
    const page = decodeChannelListingPage(result.page);
    if (!page.ok) return failure('unavailable');
    return { ok: true, v: 1, items: page.value.items, nextCursor: page.value.nextCursor };
  }

  /**
   * Lists the roster of a channel this session holds. An unheld binding and a
   * server-side `not_joined` produce the same answer, so the result is never an
   * existence oracle for channels the agent has not joined.
   */
  async listAgents(channel: BindingId, signal?: AbortSignal): Promise<AgentListOutput> {
    let status: AgentStatus;
    try { status = await this.#client.status(signal); } catch { return failure('unavailable'); }
    const held = plainObject(status) && status.connected === true && plainObject(status.binding)
      ? status.binding.bindingId : null;
    if (held === null) return failure('not_connected');
    if (held !== channel) return failure('not_joined');
    let result: unknown;
    try { result = await this.#client.listAgents({ bindingId: channel }, signal); } catch { return failure('unavailable'); }
    if (!plainObject(result)) return failure('unavailable');
    if (result.kind === 'refused' && result.code === 'not_joined') return failure('not_joined');
    if (result.kind !== 'listed') return failure('unavailable');
    const agents = decodeRoster(result.roster);
    return agents === null ? failure('unavailable') : { ok: true, v: 1, channel, agents };
  }
}

/** Exact `https:` origin, or `http:` on a loopback host; no path, query, or credentials. */
export function validOriginArgument(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.origin !== value) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

export function validCursorArgument(value: unknown): value is string {
  return decodeChannelListQuery({ v: 1, cursor: value, limit: 1 }).ok && value !== null;
}

export function validChannelArgument(value: unknown): value is BindingId {
  return validBindingArgument(value);
}

export function listingExitCode(output: ChannelListOutput | AgentListOutput): number {
  if (output.ok) return 0;
  return output.error === 'unavailable' ? 4 : 3;
}

function decodeRoster(value: unknown): readonly ChannelAgent[] | null {
  if (!plainObject(value) || !exactKeys(value, ['v', 'agents']) || value.v !== 1 || !Array.isArray(value.agents)
    || value.agents.length > MAX_CHANNEL_AGENTS) return null;
  const seen = new Set<string>();
  const agents: ChannelAgent[] = [];
  for (const entry of value.agents as unknown[]) {
    if (!plainObject(entry) || !exactKeys(entry, ['v', 'participantId', 'displayName', 'ownerDisplayName', 'connection'])
      || entry.v !== 1 || !validIdentifier(entry.participantId) || seen.has(entry.participantId)
      || typeof entry.connection !== 'string' || !(AGENT_CONNECTIONS as readonly string[]).includes(entry.connection)) return null;
    const displayName = untrustedName(entry.displayName);
    const ownerDisplayName = untrustedName(entry.ownerDisplayName);
    if (displayName === null || ownerDisplayName === null) return null;
    seen.add(entry.participantId);
    agents.push({
      v: 1, participantId: entry.participantId, displayName, ownerDisplayName, connection: entry.connection as AgentConnection,
    });
  }
  return agents;
}

function untrustedName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || Buffer.from(value).toString() !== value
    || Buffer.byteLength(value) > MAX_AGENT_DISPLAY_NAME_BYTES) return null;
  const normalized = value.replace(UNSAFE_TEXT, '�');
  return Buffer.byteLength(normalized) > MAX_AGENT_DISPLAY_NAME_BYTES ? null : normalized;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function failure(error: ListingFailure['error']): ListingFailure {
  return { ok: false, error };
}
