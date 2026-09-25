import { StoreError } from '../store/errors';
import { type ResumeMetadataV1, readResumeMetadata } from '../store/lifecycle-snapshot';
import { type InternalStoreHandle, openChannelStore } from '../store/open';
import { channelDirectory } from './paths';

export type LifecycleOpenFailureCode =
  | 'invalid_request'
  | 'missing_state'
  | 'corrupt'
  | 'schema_unsupported'
  | 'unsafe_path'
  | 'channel_running'
  | 'identity_mismatch'
  | 'unavailable';

export type LifecycleOpenFailure = Readonly<{ kind: 'failed'; code: LifecycleOpenFailureCode }>;

export type OwnedChannel = Readonly<{ directory: string; handle: InternalStoreHandle }>;

export function lifecycleFailure<Code extends string>(code: Code): Readonly<{ kind: 'failed'; code: Code }> {
  return { kind: 'failed', code };
}

function openFailureCode(error: unknown): LifecycleOpenFailureCode {
  if (!(error instanceof StoreError)) return 'unavailable';
  switch (error.code) {
    case 'missing_state':
    case 'corrupt':
    case 'schema_unsupported':
    case 'unsafe_path':
      return error.code;
    case 'locked':
      return 'channel_running';
    default:
      return 'unavailable';
  }
}

/** Opens only existing state and takes the store's exclusive owner lock. */
export function openOwnedChannel(
  root: string,
  channelId: string,
): OwnedChannel | LifecycleOpenFailure {
  const directory = channelDirectory(root, channelId);
  if (directory === null) return lifecycleFailure('invalid_request');
  try {
    return { directory, handle: openChannelStore({ directory, mode: 'existing' }) };
  } catch (error) {
    return lifecycleFailure(openFailureCode(error));
  }
}

export function isOpenFailure(value: OwnedChannel | LifecycleOpenFailure): value is LifecycleOpenFailure {
  return 'kind' in value;
}

export type ResumeResultV1 =
  | Readonly<{ kind: 'resumed'; v: 1; metadata: ResumeMetadataV1; directory: string; handle: InternalStoreHandle }>
  | LifecycleOpenFailure;

/**
 * Reopens one explicit channel. The caller owns the returned handle and must
 * close it; every failure has already released ownership and created nothing.
 */
export function resumeInternalChannel(input: Readonly<{ root: string; channelId: string }>): ResumeResultV1 {
  const owned = openOwnedChannel(input.root, input.channelId);
  if (isOpenFailure(owned)) return owned;
  let result: ReturnType<typeof readResumeMetadata>;
  try {
    result = readResumeMetadata(owned.handle, input.channelId);
  } catch {
    owned.handle.close();
    return lifecycleFailure('unavailable');
  }
  if (result.kind !== 'found') {
    owned.handle.close();
    return lifecycleFailure(result.kind);
  }
  return { kind: 'resumed', v: 1, metadata: result.value, directory: owned.directory, handle: owned.handle };
}
