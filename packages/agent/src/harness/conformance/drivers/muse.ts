import { readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { claudeStyleDriver, type FakeHarnessDriver } from '../driver';
import { watchSession, monitorArmed } from '../../../watch';
import { listChannels } from '../../../channels';
import { writeStatus, readStatus, type SessionFiles } from '../../../state';
import { MUSE_WAKE_REQUEST, museJournalPath, type MuseWakeRequest } from '../../../wake/muse-monitor';

export const MUSE_FIXTURE_SESSION = '01a10fee-e403-7390-b3a0-dd772e9d2ef7';
const turn = 'conformance-monitor-run';

export const museDriver: FakeHarnessDriver = {
  ...claudeStyleDriver('MUSE_SESSION_ID'),
  newSession: () => ({ id: MUSE_FIXTURE_SESSION, mcpEnv: { MUSE_SESSION_ID: MUSE_FIXTURE_SESSION } }),
  wakeHook: session => JSON.stringify({ session_id: session.id, hook_event_name: 'Stop', turn_id: turn, stop_hook_active: false }),
  wakeProbe(adapter, env) {
    let prompt: string | undefined;
    let controller: AbortController | undefined;
    let watching: Promise<number> | undefined;
    let dataHome: string | undefined;
    const priorDataHome = env.XDG_DATA_HOME;
    const prior = () => { if (priorDataHome === undefined) delete env.XDG_DATA_HOME; else env.XDG_DATA_HOME = priorDataHome; };
    const stop = async () => { controller?.abort(); await watching; if (dataHome) await fs.rm(dataHome, { recursive: true, force: true }); prior(); };
    return {
      drivers: adapter.wakeLadder ?? [], prompt: () => prompt, stop,
      async prepare(files: SessionFiles) {
        await stop();
        // The fake MCP clock predates wall time; refresh fixture heartbeats before
        // starting the real filesystem watcher, just as a live MCP server does.
        for (const target of [files, ...(await listChannels(files)).map(channel => channel.files)]) {
          const status = await readStatus(target);
          await writeStatus(target, status?.state ?? 'connected', status?.detail, undefined, status?.channelName, status?.displayName);
        }
        controller = new AbortController();
        dataHome = await fs.mkdtemp(path.join(path.dirname(files.dir), 'muse-data-'));
        env.XDG_DATA_HOME = dataHome;
        const journal = museJournalPath(MUSE_FIXTURE_SESSION, env)!;
        await fs.mkdir(path.dirname(journal), { recursive: true });
        const fixture = JSON.parse(await fs.readFile(new URL('../../../../../../docs/build/multi-harness/spikes/muse-fixtures/monitor/inbox-item-drained.json', import.meta.url), 'utf8'));
        watching = watchSession(files, { harness: 'muse', signal: controller.signal, env, now: () => Date.parse('2026-10-05T12:01:00Z'),
          write(line) {
            const request = JSON.parse(readFileSync(path.join(files.dir, MUSE_WAKE_REQUEST), 'utf8')) as MuseWakeRequest;
            const record = structuredClone(fixture);
            record.stream.id = MUSE_FIXTURE_SESSION;
            record.recorded_at = (request.at + 1) * 1000;
            record.payload.run_id = turn;
            record.payload.event.drain_target_run_stream.id = turn;
            record.payload.event.delivery_snapshot.body = line.trim();
            writeFileSync(journal, JSON.stringify(record) + '\n');
            prompt = line.trim();
          },
        });
        const deadline = Date.now() + 1500;
        while (!await monitorArmed(files)) {
          if (Date.now() > deadline) throw new Error('monitor_not_armed');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      },
    };
  },
};
