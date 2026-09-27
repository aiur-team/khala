import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';

// The installed hook and MCP entry are separate processes. Only a completed,
// unblocked Stop establishes idleness; every later hook boundary clears it.
// An absent, stale or unreadable record never licenses a native wake.
export type CodexIdleActivity = Readonly<{
  mark(binding: SessionBinding, idle: boolean, sessionId: string): Promise<void>;
  idleSession(binding: SessionBinding): Promise<Readonly<{ epoch: string; sessionId: string }> | null>;
  idleEpoch(binding: SessionBinding): Promise<string | null>;
}>;

export function createCodexIdleActivity(stateDirectory: string): CodexIdleActivity {
  const directory = path.join(stateDirectory, 'codex-idle-activity');
  const file = (binding: SessionBinding) => path.join(directory, createHash('sha256')
    .update(JSON.stringify([binding.bindingId, binding.generation])).digest('base64url') + '.json');
  return {
    async mark(binding, idle, sessionId) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const target = file(binding);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ v: 1, bindingId: binding.bindingId,
          generation: binding.generation, idle, sessionId, epoch: randomUUID() }), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, target);
      } finally {
        await fs.unlink(temporary).catch(() => undefined);
      }
    },
    async idleSession(binding) {
      try {
        const stat = await fs.lstat(file(binding));
        if (!stat.isFile() || stat.size > 512 || (stat.mode & 0o077) !== 0) return null;
        const value: unknown = JSON.parse(await fs.readFile(file(binding), 'utf8'));
        if (typeof value !== 'object' || value === null) return null;
        const record = value as Record<string, unknown>;
        return record.v === 1 && record.bindingId === binding.bindingId && record.generation === binding.generation
          && record.idle === true && typeof record.epoch === 'string' && typeof record.sessionId === 'string'
          && record.sessionId.length > 0 ? { epoch: record.epoch, sessionId: record.sessionId } : null;
      } catch { return null; }
    },
    async idleEpoch(binding) { return (await this.idleSession(binding))?.epoch ?? null; },
  };
}
