import os from 'node:os';
import path from 'node:path';
import { installedLauncher, launcherShellQuote } from '../install/launcher';

export function antigravityRegisterCommand(env: NodeJS.ProcessEnv = process.env, bin?: string): string {
  const platform = process.platform;
  const home = platform === 'win32' ? env.USERPROFILE || os.homedir() : env.HOME || os.homedir();
  return launcherShellQuote(platform, bin ?? installedLauncher(platform, platform === 'win32' ? path.win32 : path.posix, home, env).bin)
    + ' wake register --harness antigravity';
}
export function antigravityRegisterHint(env: NodeJS.ProcessEnv = process.env, bin?: string): string {
  return `Run ${antigravityRegisterCommand(env, bin)} through your own shell tool after khala_join and at every session start; repeat if the local server restarts. Never print or send the credential environment variables.`;
}
