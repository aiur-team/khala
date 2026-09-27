import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { HarnessCapabilities } from '../../../packages/contracts/src/delivery/index';
import { inspectHostedCodexHooks } from '../../../packages/agent-cli/src/composition/local-harness-capabilities';
import { readInstalledCodexVersion } from '../../../packages/agent-cli/src/composition/hosted-session-inspection';
import { setupEnvironment } from '../../../packages/agent-cli/src/setup/environment';

export type NativeFixture = Readonly<{
  v: 1;
  disposable: true;
  harness: 'codex';
  sessionId: string;
  workdir: string;
  codexHome: string;
}>;

export type NativeGate =
  | Readonly<{ kind: 'ready'; fixture: NativeFixture; capabilities: HarnessCapabilities }>
  | Readonly<{ kind: 'blocked'; code: string }>;

const absoluteDirectory = (value: unknown) => typeof value === 'string' && path.isAbsolute(value)
  && path.normalize(value) === value && !value.includes('\0');

/** A native fixture names one already-running, disposable owner session. */
export async function inspectNativeGate(descriptorPath: string | undefined): Promise<NativeGate> {
  if (!descriptorPath) return { kind: 'blocked', code: 'native_fixture_not_supplied' };
  if (!path.isAbsolute(descriptorPath)) return { kind: 'blocked', code: 'native_fixture_path_invalid' };
  let fixture: NativeFixture;
  try {
    const value = JSON.parse(await readFile(descriptorPath, 'utf8')) as Partial<NativeFixture>;
    if (value.v !== 1 || value.disposable !== true || value.harness !== 'codex'
      || typeof value.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(value.sessionId)
      || !absoluteDirectory(value.workdir) || !absoluteDirectory(value.codexHome)) {
      return { kind: 'blocked', code: 'native_fixture_invalid' };
    }
    fixture = value as NativeFixture;
  } catch {
    return { kind: 'blocked', code: 'native_fixture_unreadable' };
  }
  const environment = setupEnvironment({ ...process.env, CODEX_HOME: fixture.codexHome });
  const [version, hooks] = await Promise.all([
    readInstalledCodexVersion(environment),
    inspectHostedCodexHooks(environment),
  ]);
  if (version !== '0.154.0') return { kind: 'blocked', code: 'native_version_unproven' };
  if (!hooks || hooks.support !== 'tested' || hooks.harness !== 'codex' || hooks.version !== version
    || hooks.modes.sync.status !== 'proven') {
    return { kind: 'blocked', code: 'native_hook_mode_unproven' };
  }
  return { kind: 'ready', fixture, capabilities: hooks };
}
