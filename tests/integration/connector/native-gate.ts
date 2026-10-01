import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { HarnessCapabilities } from '../../../packages/contracts/src/delivery/index';
import { CODEX_NATIVE_SYNC_VERSIONS } from '../../../packages/harnesses/src/codex/interactive';
import { inspectHostedCodexHooks } from '../../../packages/agent-cli/src/composition/local-harness-capabilities';
import { readInstalledCodexVersion } from '../../../packages/agent-cli/src/composition/hosted-session-inspection';
import { setupEnvironment } from '../../../packages/agent-cli/src/setup/environment';
import { inspectNativeSolHandoff, type NativeSolHandoff } from './native-sol-handoff';

export type NativeFixture = Readonly<{
  v: 1;
  disposable: true;
  harness: 'codex';
  sessionId: string;
  workdir: string;
  codexHome: string;
}>;
type NativeSolFixture = Omit<NativeFixture, 'v'> & NativeSolHandoff & Readonly<{ v: 2 }>;

export type NativeGate =
  | Readonly<{ kind: 'ready'; fixture: NativeFixture; capabilities: HarnessCapabilities;
      preflightBindingId: string }>
  | Readonly<{ kind: 'blocked'; code: string }>;

/** This Sol crash acceptance gate is narrower than production's older Codex routes. */
export function nativeProofBlock(version: string | null, hooks: HarnessCapabilities | null): string | null {
  if (version === null || !CODEX_NATIVE_SYNC_VERSIONS.includes(version)) return 'native_version_unproven';
  if (!hooks || hooks.support !== 'tested' || hooks.harness !== 'codex' || hooks.version !== version
    || hooks.modes.sync.status !== 'proven') return 'native_hook_mode_unproven';
  return null;
}

const absoluteDirectory = (value: unknown) => typeof value === 'string' && path.isAbsolute(value)
  && path.normalize(value) === value && !value.includes('\0');

/** A native fixture names one already-running, disposable owner session. */
export async function inspectNativeGate(descriptorPath: string | undefined): Promise<NativeGate> {
  if (!descriptorPath) return { kind: 'blocked', code: 'native_fixture_not_supplied' };
  if (!path.isAbsolute(descriptorPath)) return { kind: 'blocked', code: 'native_fixture_path_invalid' };
  let descriptor: NativeFixture | NativeSolFixture;
  let descriptorMode: number;
  try {
    const file = await lstat(descriptorPath);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.()
      || file.size > 64 * 1024) return { kind: 'blocked', code: 'native_fixture_invalid' };
    descriptorMode = file.mode;
    const value = JSON.parse(await readFile(descriptorPath, 'utf8')) as
      Partial<Omit<NativeFixture, 'v'> & NativeSolHandoff> & { v?: number };
    if ((value.v !== 1 && value.v !== 2) || value.disposable !== true || value.harness !== 'codex'
      || typeof value.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(value.sessionId)
      || !absoluteDirectory(value.workdir) || !absoluteDirectory(value.codexHome)) {
      return { kind: 'blocked', code: 'native_fixture_invalid' };
    }
    descriptor = value as NativeFixture | NativeSolFixture;
  } catch {
    return { kind: 'blocked', code: 'native_fixture_unreadable' };
  }
  const environment = setupEnvironment({ ...process.env, CODEX_HOME: descriptor.codexHome });
  const [version, hooks] = await Promise.all([
    readInstalledCodexVersion(environment),
    inspectHostedCodexHooks(environment),
  ]);
  const blocked = nativeProofBlock(version, hooks);
  if (blocked !== null) return { kind: 'blocked', code: blocked };
  if (hooks === null) throw new Error('native proof guard failed');
  if (descriptor.v !== 2 || (descriptorMode & 0o077) !== 0) {
    return { kind: 'blocked', code: 'native_sol_handoff_unproven' };
  }
  const handoff = await inspectNativeSolHandoff(descriptor, version!);
  if (handoff.kind !== 'ready') return { kind: 'blocked', code: handoff.code };
  const fixture: NativeFixture = { v: 1, disposable: true, harness: 'codex',
    sessionId: descriptor.sessionId, workdir: descriptor.workdir, codexHome: descriptor.codexHome };
  return { kind: 'ready', fixture, capabilities: hooks, preflightBindingId: handoff.bindingId };
}
