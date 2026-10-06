import { validAgentRejoinSecret } from '@khala/contracts/m1/agent-join';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { cachedProcessReader } from './harness/proc';
import { listChannels } from './channels';
import { readStateFile, readStatus, TERMINAL_SESSION_DETAILS, type SessionFiles } from './state';

/** Connected channels can wake; authorized restores can arm while MCP rejoins. */
export async function sessionStartWakeChannels(files: SessionFiles, env: NodeJS.ProcessEnv): Promise<{ files: SessionFiles; connected: boolean }[]> {
  const read = cachedProcessReader();
  const channels = await listChannels(files);
  const secret = (await readStateFile<{ secret?: unknown }>(files.dir, 'rejoin.json'))?.secret;
  const hash = validAgentRejoinSecret(secret) ? createHash('sha256').update(secret).digest('hex') : undefined;
  const candidates = channels.length ? channels : [{ files, roomId: undefined }];
  const result: { files: SessionFiles; connected: boolean }[] = [];
  for (const channel of candidates) {
    const status = await readStatus(channel.files, read);
    if (TERMINAL_SESSION_DETAILS.some(detail => detail === status?.detail)) continue;
    if (status?.state === 'connected' || status?.state === 'send_failed') {
      result.push({ files: channel.files, connected: true });
      continue;
    }
    if (!channel.roomId || !hash || !['joining', 'disconnected'].includes(status?.state ?? '')) continue;
    const authorization = await readStateFile<{
      roomId?: unknown; workspace?: unknown; secretHash?: unknown; link?: unknown; label?: unknown;
      localCredentials?: { transport?: unknown; roomId?: unknown };
    }>(channel.files.dir, 'resume.json');
    if (!authorization || authorization.roomId !== channel.roomId
      || authorization.workspace !== path.resolve(env.PWD ?? process.cwd()) || authorization.secretHash !== hash
      || typeof authorization.link !== 'string' || typeof authorization.label !== 'string'
      || authorization.localCredentials && (authorization.localCredentials.transport !== 'local' || authorization.localCredentials.roomId !== channel.roomId)) continue;
    result.push({ files: channel.files, connected: false });
  }
  return result;
}
