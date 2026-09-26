import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DeviceId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import { isInternalChannelArgument } from '@khala/contracts/internal/command';
import {
  activeDescriptorPath, ensurePrivateDirectory, removeActiveDescriptor, removeLaunchRecord,
  writeActiveDescriptor, writeLaunchRecord,
} from '../descriptor/write';
import { type BindingControl, composeBindingControl } from '../composition/binding-control/index';
import { createInternalReleaseFeed } from '../composition/internal-delivery/release-feed';
import { composeInternalChannelDiscovery } from '../composition/channel-discovery/service';
import { composeClaudeSession } from '../composition/claude-session/compose';
import { CHANNELS_DIRECTORY, channelDirectory } from '../lifecycle/paths';
import { createSqliteListeningModeRepository } from '../listening-mode-store/sqlite';
import { resumeInternalChannel } from '../lifecycle/resume';
import type { AssetManifest } from '../server/assets';
import { BOOTSTRAP_DOCUMENT_ROUTE } from '../server/bootstrap';
import { startChannelServer } from '../server/channel-server';
import { type HumanAuthority, mintCredential } from '../server/credentials';
import type { LoopbackServer } from '../server/server';
import { type ChannelStore, createChannelStore } from '../store/channel-store';
import { createSqliteControlStore } from '../store/control-store';
import { createDiscoveryStore } from '../store/discovery-store';
import { bindLifecycleChannel } from '../store/lifecycle-snapshot';
import { type InternalStoreHandle, openChannelStore } from '../store/open';
import { createReceiptReadModel } from '../store/receipts';
import type { OpenBootstrapInput, OpenOutcome } from './browser-handoff';
import { type RootLease, acquireRootLease } from './lock';

// The internal launcher starts exactly one local owner server for one channel
// and nothing else: it never starts, wraps, signals or waits on an agent CLI.
//
// Ownership is taken and released in a fixed order:
//   root lease -> channel store -> credentials -> listening server
//   -> launch.json + active.json -> running
// and shutdown walks it back: discovery removed, browser handoff removed,
// server closed, store closed, root lease released last.

export const HANDOFF_DIRECTORY = 'handoff';
/** How long the printed bootstrap URL can be exchanged for a browser session. */
export const BOOTSTRAP_TTL_MS = 15 * 60_000;
export const HUMAN_DISPLAY_NAME = 'Owner';
/** Upper bound on how long a private browser redirect file exists. */
export const HANDOFF_DEADLINE_MS = 60_000;

export type LaunchRequest =
  | Readonly<{ kind: 'create' }>
  | Readonly<{ kind: 'resume'; channelId: string }>;

export type LaunchFailureCode =
  | 'launcher_running'
  | 'unsafe_path'
  | 'io_failed'
  | 'invalid_request'
  | 'missing_state'
  | 'corrupt'
  | 'schema_unsupported'
  | 'channel_running'
  | 'identity_mismatch'
  | 'unavailable'
  | 'server_failed'
  | 'publish_failed';

export type LaunchReport = Readonly<{
  channelId: string;
  resumeCommand: string;
  descriptorPath: string;
  origin: string;
  port: number;
  /** True when the requested port was taken by an unrelated listener. */
  portFallback: boolean;
  /** Manual bootstrap URL; carries the one-time credential in its fragment. */
  url: string;
}>;

export type RunningLaunch = Readonly<{
  kind: 'running';
  report: LaunchReport;
  /**
   * Best-effort automatic browser opening, run after the report is printed so it
   * can never delay the manual URL. Resolves whether a browser was started; never throws.
   */
  openBrowser(): Promise<boolean>;
  /** Idempotent; every call resolves after the same single shutdown. */
  shutdown(): Promise<void>;
}>;

export type LaunchFailure = Readonly<{
  kind: 'failed';
  code: LaunchFailureCode;
  /** Present when durable channel state exists and can be resumed later. */
  channelId?: string;
  resumeCommand?: string;
}>;

export type LaunchOutcome = RunningLaunch | LaunchFailure;

export type LauncherOptions = Readonly<{
  /** Absolute private internal root; its parent must already exist. */
  root: string;
  request: LaunchRequest;
  assets: AssetManifest;
  startPort?: number;
  clock?: () => number;
  /** Opaque identifier source for new channel, owner, participant and device IDs. */
  newToken?: () => string;
  openBrowser?: (input: Pick<OpenBootstrapInput, 'bootstrapUrl' | 'credential' | 'handoffParent'>) => Promise<OpenOutcome>;
  /** Test seam: runs after the lease is taken and before any other state is touched. */
  afterLease?: () => void;
}>;

export function resumeCommandFor(channelId: string): string {
  // Channel arguments are route segments; only a leading `~` needs quoting for a shell.
  return `khala internal --resume ${channelId.startsWith('~') ? `'${channelId}'` : channelId}`;
}

export function bootstrapUrlFor(origin: string, credential: string, channelId: string): string {
  return `${origin}${BOOTSTRAP_DOCUMENT_ROUTE}#credential=${credential}&channel=${encodeURIComponent(channelId)}`;
}

type OpenedChannel = Readonly<{
  channelId: string;
  directory: string;
  handle: InternalStoreHandle;
  store: ChannelStore;
  human: HumanAuthority;
}>;

type OpenFailure = Readonly<{ kind: 'failed'; code: LaunchFailureCode }>;

function failure(code: LaunchFailureCode, channelId?: string): LaunchFailure {
  return channelId === undefined ? { kind: 'failed', code } : { kind: 'failed', code, channelId, resumeCommand: resumeCommandFor(channelId) };
}

/** Creates one human-only channel with zero agent bindings. */
function createChannel(root: string, now: number, token: () => string): OpenedChannel | OpenFailure {
  const channelId = `ch_${token()}`;
  const directory = channelDirectory(root, channelId);
  if (directory === null) return { kind: 'failed', code: 'invalid_request' };
  let handle: InternalStoreHandle;
  try {
    handle = openChannelStore({ directory, mode: 'create' });
  } catch {
    return { kind: 'failed', code: 'unavailable' };
  }
  const human: HumanAuthority = {
    ownerId: `owner_${token()}` as OwnerId,
    participantId: `participant_${token()}` as ParticipantId,
    deviceId: `device_${token()}` as DeviceId,
  };
  const store = createChannelStore(handle);
  try {
    const steps = [
      () => store.registerParticipant({
        participantId: human.participantId, ownerId: human.ownerId, kind: 'human', displayName: HUMAN_DISPLAY_NAME,
      }).kind === 'done',
      () => store.registerDevice({ deviceId: human.deviceId, participantId: human.participantId }).kind === 'done',
      () => store.createChannel({
        operationId: `create_${token()}`, channelId: channelId as RoomId, title: null, creatorOwnerId: human.ownerId,
        creatorParticipantId: human.participantId, creatorDeviceId: human.deviceId, createdAt: new Date(now).toISOString(),
      }).kind === 'created',
      () => bindLifecycleChannel(handle, channelId).kind === 'bound',
    ];
    for (const step of steps) if (!step()) throw new Error('create');
  } catch {
    // Nothing was reported yet and the directory is this run's fresh random ID.
    try { handle.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
    return { kind: 'failed', code: 'unavailable' };
  }
  return { channelId, directory, handle, store, human };
}

/** Opens exactly the existing channel and recovers its stable human identity. */
function resumeChannel(root: string, channelId: string): OpenedChannel | OpenFailure {
  if (!isInternalChannelArgument(channelId)) return { kind: 'failed', code: 'invalid_request' };
  const resumed = resumeInternalChannel({ root, channelId });
  if (resumed.kind === 'failed') return { kind: 'failed', code: resumed.code };
  const store = createChannelStore(resumed.handle);
  const roster = store.roster(channelId as RoomId);
  const creator = roster.kind === 'done'
    ? roster.participants.find(participant => participant.participantId === resumed.metadata.creatorParticipantId)
    : undefined;
  if (!creator || creator.kind !== 'human' || !creator.deviceIds.includes(resumed.metadata.creatorDeviceId as DeviceId)) {
    resumed.handle.close();
    return { kind: 'failed', code: roster.kind === 'unavailable' ? 'unavailable' : 'corrupt' };
  }
  return {
    channelId,
    directory: resumed.directory,
    handle: resumed.handle,
    store,
    human: { ownerId: creator.ownerId, participantId: creator.participantId, deviceId: resumed.metadata.creatorDeviceId as DeviceId },
  };
}

/** Removes leftovers of a launcher that no longer holds the lease. */
function recoverStaleRuntime(root: string): void {
  removeActiveDescriptor(root);
  const handoff = path.join(root, HANDOFF_DIRECTORY);
  fs.rmSync(handoff, { recursive: true, force: true });
  ensurePrivateDirectory(handoff);
  const channels = path.join(root, CHANNELS_DIRECTORY);
  ensurePrivateDirectory(channels);
  // A killed launcher leaves its bootstrap credential behind; no launcher owns it now.
  for (const entry of fs.readdirSync(channels, { withFileTypes: true })) {
    if (entry.isDirectory()) removeLaunchRecord(path.join(channels, entry.name));
  }
}

export async function launchInternal(options: LauncherOptions): Promise<LaunchOutcome> {
  const { root } = options;
  const clock = options.clock ?? Date.now;
  const token = options.newToken ?? (() => randomBytes(16).toString('base64url'));
  if (!path.isAbsolute(root) || path.resolve(root) !== root) return failure('unsafe_path');

  // The lease comes first. Until it is held nothing below may read or change
  // runtime state, probe a port or mint a credential: a second launcher must
  // be refused here even when another port is free.
  const leased = acquireRootLease(root);
  if (leased.kind === 'held') return failure('launcher_running');
  if (leased.kind === 'failed') return failure(leased.code);
  const lease: RootLease = leased.lease;

  let opened: OpenedChannel | null = null;
  let server: LoopbackServer | null = null;
  let bindingControl: BindingControl | null = null;
  let stopping: Promise<void> | null = null;
  const timers: NodeJS.Timeout[] = [];
  const handoffCleanups: Array<() => Promise<void>> = [];
  const release = async (): Promise<void> => {
    for (const timer of timers.splice(0)) clearTimeout(timer);
    // Discovery first, so no client can find a server that is going away.
    bindingControl?.close();
    try { removeActiveDescriptor(root); } catch {}
    if (opened) try { removeLaunchRecord(opened.directory); } catch {}
    await Promise.all(handoffCleanups.splice(0).map(cleanup => cleanup().catch(() => {})));
    if (server) await server.close().catch(() => {});
    if (opened) try { opened.handle.close(); } catch {}
    lease.release();
  };
  const later = (milliseconds: number, run: () => void): void => {
    const timer = setTimeout(() => { try { run(); } catch {} }, Math.max(0, milliseconds));
    timer.unref();
    timers.push(timer);
  };

  // Everything after the lease releases it on any failure, expected or not.
  let createdChannelId: string | undefined;
  try {
    options.afterLease?.();
    try {
      recoverStaleRuntime(root);
    } catch {
      await release();
      return failure('unsafe_path');
    }

    const now = clock();
    const channel = options.request.kind === 'create'
      ? createChannel(root, now, token)
      : resumeChannel(root, options.request.channelId);
    if ('kind' in channel) {
      await release();
      return failure(channel.code);
    }
    opened = channel;
    // A created channel is durable user state: from here on, failures say how to resume it.
    createdChannelId = channel.channelId;

    const bootstrapCredential = mintCredential();
    const transportCapability = mintCredential();
    const expiresAt = now + BOOTSTRAP_TTL_MS;
    const requestedPort = options.startPort;
    try {
      const discovery = await composeInternalChannelDiscovery({
        control: createSqliteControlStore(channel.handle, clock),
        store: createDiscoveryStore(channel.handle),
        human: channel.human,
        clock,
        newChannelId: () => `ch_${token()}`,
      });
      // Claude sessions present the transport capability from `active.json` and join as themselves.
      const claude = await composeClaudeSession({
        root, store: channel.store, transportCapability, clock,
      });
      bindingControl = composeBindingControl({ handle: channel.handle, root });
      server = await startChannelServer({
        store: channel.store,
        bootstrap: [{ credential: bootstrapCredential, channelId: channel.channelId as RoomId, expiresAt, human: channel.human }],
        // Agent bindings are granted later through channel access, never at launch.
        bindings: [],
        // A granted binding pulls its releases into its own inbox; nothing is pushed.
        releases: createInternalReleaseFeed({
          store: channel.store,
          listeningModes: createSqliteListeningModeRepository(channel.handle),
        }),
        // The owner's projected receipt evidence, read-only; the projector owns writes.
        receipts: createReceiptReadModel(channel.handle),
        // The transport capability may only obtain a discovery-only descriptor.
        transportCapability,
        discovery: discovery.port,
        agentSession: claude.route,
        // Stop revokes bindings and delivery only; the server keeps running until launcher shutdown.
        stop: bindingControl,
        assets: options.assets,
        newId: randomUUID,
        clock,
        ...(requestedPort === undefined ? {} : { startPort: requestedPort }),
      });
    } catch {
      await release();
      return failure('server_failed', channel.channelId);
    }
    const origin = server.origin;

    try {
      writeLaunchRecord(channel.directory, { v: 1, channelId: channel.channelId, origin, bootstrapCredential, expiresAt });
      // Published only once the server is listening; transport discovery only.
      writeActiveDescriptor(root, { v: 1, channelId: channel.channelId, origin, transportCapability });
    } catch {
      await release();
      return failure('publish_failed', channel.channelId);
    }
    // The bootstrap record is useless once its credential expires.
    later(expiresAt - clock(), () => removeLaunchRecord(channel.directory));

    const url = bootstrapUrlFor(origin, bootstrapCredential, channel.channelId);
    return {
      kind: 'running',
      report: {
        channelId: channel.channelId,
        resumeCommand: resumeCommandFor(channel.channelId),
        descriptorPath: activeDescriptorPath(root),
        origin,
        port: server.port,
        portFallback: requestedPort !== undefined && requestedPort !== 0 && server.port !== requestedPort,
        url,
      },
      async openBrowser() {
        if (!options.openBrowser || stopping) return false;
        let outcome: OpenOutcome;
        try {
          outcome = await options.openBrowser({
            bootstrapUrl: url, credential: bootstrapCredential, handoffParent: path.join(root, HANDOFF_DIRECTORY),
          });
        } catch {
          return false;
        }
        if (!outcome.opened) return false;
        if (stopping) {
          await outcome.cleanup().catch(() => {});
          return true;
        }
        handoffCleanups.push(outcome.cleanup);
        // The browser reads the redirect file as it starts; it never outlives this deadline.
        later(Math.min(HANDOFF_DEADLINE_MS, expiresAt - clock()), () => void outcome.cleanup().catch(() => {}));
        return true;
      },
      shutdown() {
        stopping ??= release();
        return stopping;
      },
    };
  } catch {
    stopping ??= release();
    await stopping;
    return failure('unavailable', createdChannelId);
  }
}
