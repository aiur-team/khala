import type { SessionFiles } from '../state';
import type { WakeDriver as SharedWakeDriver } from './shared/driver';

export type WakeDriverContext = Readonly<{
  files: SessionFiles;
  harness: string;
  sessionId: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  now: number;
}>;

export type WakeDriver = SharedWakeDriver<WakeDriverContext>;
