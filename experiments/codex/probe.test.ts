import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAttachmentProbe, type ProbeInput } from './probe.js';

const id = '11111111-1111-4111-8111-111111111111';
const input: ProbeInput = { sessionId: id, expectedWorkdir: '/synthetic-workdir', nonce: 'release-nonce-7', mode: 'idle', deadlineMs: 2000 };
// A fake executable exercises the public function through its real process boundary.
async function fixture(overrides: object, run: (calls: () => Promise<any[]>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'kha104-probe-test-'));
  const oldPath = process.env.PATH;
  const log = join(dir, 'calls.jsonl');
  // The fake is extensionless; pin CommonJS in case tmpdir sits under an ESM package.
  await writeFile(join(dir, 'package.json'), '{"type":"commonjs"}');
  await writeFile(join(dir, 'codex'), `#!${process.execPath}
const fs=require('node:fs');
const o=${JSON.stringify(overrides)};
if(process.argv.includes('--version')) {console.log('codex-cli '+(o.version??'0.154.0'));process.exit(0);}
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
 if(!m.id)return;
 if(o.hang)return;
 if(m.method==='thread/queue/add' && o.disconnect){process.exit(0);}
 const thread={id:${JSON.stringify(id)},cwd:'/synthetic-workdir',model:'private-model-secret',canAcceptDirectInput:true,status:{type:'idle'},preview:'private-conversation-secret',...o.thread};
 let result=m.method==='thread/read'?{thread}:m.method==='thread/queue/add'?{queuedSubmission:{id:'opaque-queue-id',clientUserMessageId:m.params.clientUserMessageId}}:{};
 console.log(JSON.stringify(o.remoteError?{id:m.id,error:{code:-32000,message:'Bearer credential-secret /home/private-person/context'}}:{id:m.id,result}));
});
`, { mode: 0o700 });
  process.env.PATH = dir + ':' + oldPath;
  try {
    await run(async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } });
  } finally {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
}

test('invalid or private nonce inputs fail before launching a process', async () => {
  for (const change of [{ sessionId: '../private' }, { nonce: 'secret text' }, { expectedWorkdir: 'relative' }, { deadlineMs: Infinity }, { release: 'yes' }, { socketPath: 'relative' }]) {
    await assert.rejects(runAttachmentProbe({ ...input, ...change } as ProbeInput), /Invalid probe input/);
  }
});
test('preflight never enqueues, resumes, starts, or reads conversation history', async () => {
  await fixture({}, async calls => {
    const report = await runAttachmentProbe(input);
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.observedSessionId, id);
    assert.equal(report.facts.inputAttempted, false);
    assert.deepEqual((await calls()).map(x => x.method), ['initialize', 'initialized', 'thread/read']);
    assert.equal((await calls())[2].params.includeTurns, false);
  });
});
test('wrong identity, cwd, unloaded input, missing model, and wrong busy state prevent enqueue', async () => {
  for (const thread of [{ id: '22222222-2222-4222-8222-222222222222' }, { cwd: '/other' }, { canAcceptDirectInput: false }, { model: null }, { status: { type: 'active' } }]) {
    await fixture({ thread }, async calls => {
      const report = await runAttachmentProbe({ ...input, release: true });
      assert.equal(report.facts.inputAttempted, false);
      assert.ok(!(await calls()).some(x => x.method === 'thread/queue/add'));
    });
  }
});
test('queue receipt alone stays inconclusive and report excludes raw metadata', async () => {
  await fixture({}, async calls => {
    const report = await runAttachmentProbe({ ...input, release: true });
    assert.equal(report.facts.queueAccepted, true);
    assert.equal(report.facts.consumptionObserved, false);
    assert.equal(report.facts.modelUnchanged, true);
    assert.equal(report.outcome, 'inconclusive');
    assert.match(report.facts.queueId!, /^sha256:[a-f0-9]{64}$/);
    const requests = await calls();
    assert.equal(requests.filter(x => x.method === 'thread/queue/add').length, 1);
    assert.ok(!JSON.stringify(requests).includes('prior-marker-codex-alpha'));
    const published = JSON.stringify(report);
    for (const secret of ['private-model-secret', 'private-conversation-secret', 'opaque-queue-id', '/synthetic-workdir', 'release-nonce-7']) assert.ok(!published.includes(secret));
    assert.equal(report.observations.at(-1)?.kind, 'client_cleaned_up');
  });
});
test('disconnect after request is ambiguous and never retried', async () => {
  await fixture({ disconnect: true }, async calls => {
    const report = await runAttachmentProbe({ ...input, release: true });
    assert.equal(report.facts.inputAttempted, true);
    assert.equal(report.facts.queueAccepted, false);
    assert.ok(report.limitations.some(x => x.includes('uncertain')));
    assert.equal((await calls()).filter(x => x.method === 'thread/queue/add').length, 1);
  });
});
test('native errors cannot expose credentials or private paths', async () => {
  await fixture({ remoteError: true }, async () => {
    const report = await runAttachmentProbe(input);
    const published = JSON.stringify(report);
    assert.ok(!published.includes('credential-secret'));
    assert.ok(!published.includes('private-person'));
    assert.ok(report.observations.some(x => x.kind === 'transport_remote'));
  });
});
test('unknown versions do not connect or send', async () => {
  await fixture({ version: '0.155.0' }, async calls => {
    const report = await runAttachmentProbe({ ...input, release: true });
    assert.equal(report.facts.inputAttempted, false);
    assert.deepEqual(await calls(), []);
  });
});
test('absolute deadline returns with cleanup rather than hanging', async () => {
  await fixture({ hang: true }, async () => {
    const start = performance.now();
    const report = await runAttachmentProbe({ ...input, deadlineMs: 300 });
    assert.ok(performance.now() - start < 1500);
    assert.ok(report.observations.some(x => x.kind === 'transport_deadline'));
    assert.equal(report.observations.at(-1)?.kind, 'client_cleaned_up');
  });
});
