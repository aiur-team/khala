import path from 'node:path';
import type { SessionInspectionPort } from '@khala/connector/bootstrap/index';
import { nativeCliCapabilities, NATIVE_CLI_CODEX_VERSIONS } from '@khala/harnesses/codex/capabilities';
import { LOCAL_DELIVERY_LIMITS } from './local-harness-capabilities.js';
import type { HarnessSession } from './session-grant.js';
import { parseCodexVersion } from '../setup/adapters/codex.js';
import type { SetupEnvironment } from '../setup/types.js';

export type NativeSessionGeneration = (session: HarnessSession) => Promise<number | null>;

/** Probes the installed executable; a shell-provided version string is never evidence. */
export async function readInstalledCodexVersion(environment: SetupEnvironment): Promise<string | null> {
  try {
    const executable = await environment.probe.resolveExecutable('codex');
    return executable === null ? null : parseCodexVersion(await environment.probe.runVersion(executable, ['--version']));
  } catch {
    return null;
  }
}

/**
 * The installed Codex MCP host supplies `_meta.threadId` on each call. The host
 * pins that identity for this connector instance; a channel claim cannot select
 * another thread or workdir. The durable connector owns generation allocation.
 */
export function codexMcpSessionInspection(input: Readonly<{
  session: HarnessSession;
  workdir: string;
  readVersion(): Promise<string | null>;
  generation: NativeSessionGeneration;
}>): SessionInspectionPort {
  return {
    async inspect(claim) {
      if (input.session.harness !== 'codex' || claim.harness !== input.session.harness) return { kind: 'unsupported' };
      if (claim.sessionId !== input.session.sessionId || claim.workdir !== input.workdir
        || !path.isAbsolute(claim.workdir) || path.normalize(claim.workdir) !== claim.workdir) return { kind: 'missing' };
      try {
        const [version, generation] = await Promise.all([input.readVersion(), input.generation(input.session)]);
        if (version === null || !NATIVE_CLI_CODEX_VERSIONS.includes(version)) return { kind: 'unsupported' };
        if (generation === null || !Number.isSafeInteger(generation) || generation < 0) return { kind: 'unavailable' };
        return {
          kind: 'verified',
          session: { harness: 'codex', sessionId: input.session.sessionId, generation },
          capabilities: nativeCliCapabilities(version, LOCAL_DELIVERY_LIMITS),
        };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}
