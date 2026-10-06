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

export type WakeDriver = SharedWakeDriver<WakeDriverContext> & {
  /** Native monitor emission itself starts activity before journal proof arrives. */
  startsActivity?: boolean;
  /** Native ingress proof must settle before activity-only polling voids attempts. */
  verify?: (ctx: WakeDriverContext) => Promise<void>;
};
