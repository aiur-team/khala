import path from 'node:path';
import type { SessionInspectionPort } from '@khala/connector/bootstrap/index';
import { nativeCliCapabilities, NATIVE_CLI_CODEX_VERSIONS, unsupportedNativeCliCapabilities } from '@khala/harnesses/codex/capabilities';
import { installedClaudeCapabilities } from '@khala/harnesses/claude/interactive';
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
 * `_meta.threadId` is caller-controlled JSON-RPC data. This check binds only a
 * local label to this connector instance; it makes no provider identity claim.
 * Hosted authority requires a separate owner-approved proof key.
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
        // The MCP caller supplied this exact session label; owner approval of
        // its proof key remains separate. Version only controls delivery claims.
        if (generation === null || !Number.isSafeInteger(generation) || generation < 0) return { kind: 'unavailable' };
        return {
          kind: 'verified',
          session: { harness: 'codex', sessionId: input.session.sessionId, generation },
          capabilities: version !== null && NATIVE_CLI_CODEX_VERSIONS.includes(version)
            ? nativeCliCapabilities(version, LOCAL_DELIVERY_LIMITS)
            : unsupportedNativeCliCapabilities(version ?? 'unknown', LOCAL_DELIVERY_LIMITS),
        };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}

/** The Claude ID is only a local label for an owner-approved key, never provider session evidence. */
export function claudeProofKeyLabelInspection(input: Readonly<{
  session: HarnessSession;
  workdir: string;
  readVersion(): Promise<string | null>;
}>): SessionInspectionPort {
  return { async inspect(claim) {
    if (input.session.harness !== 'claude' || claim.harness !== 'claude'
      || claim.sessionId !== input.session.sessionId || claim.workdir !== input.workdir
      || !path.isAbsolute(claim.workdir) || path.normalize(claim.workdir) !== claim.workdir) return { kind: 'missing' };
    const version = await input.readVersion().catch(() => null);
    return { kind: 'verified', session: { harness: 'claude', sessionId: input.session.sessionId, generation: 0 },
      capabilities: installedClaudeCapabilities(version, LOCAL_DELIVERY_LIMITS) };
  } };
}
