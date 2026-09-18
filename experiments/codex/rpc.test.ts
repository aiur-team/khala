import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonlRpcClient, RpcTransportError } from './rpc.js';

const prelude = `import readline from 'node:readline';
const lines = readline.createInterface({input: process.stdin});
const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
`;
function client(script: string, deadlineMs = 3000) {
  return new JsonlRpcClient({ command: process.execPath, args: ['--input-type=module', '-e', prelude + script], deadlineMs });
}
const code = (expected: string) => (error: unknown) => error instanceof RpcTransportError && error.code === expected;

test('correlates concurrent responses and handles fragmented multibyte lines', async () => {
  const rpc = client(`
    const requests=[];
    lines.on('line', line => {
      requests.push(JSON.parse(line));
      if(requests.length===2) {
        const bytes=Buffer.from(JSON.stringify({id:requests[1].id,result:'β'})+'\\n'+JSON.stringify({id:requests[0].id,result:'first'})+'\\n');
        let i=0; const timer=setInterval(()=>{ process.stdout.write(bytes.subarray(i,++i)); if(i===bytes.length)clearInterval(timer); },1);
      }
    });
  `);
  try { assert.deepEqual(await Promise.all([rpc.request('one'), rpc.request('two')]), ['first', 'β']); }
  finally { await rpc.close(); }
});

test('notifications have no id and are received separately from responses', async () => {
  const notifications: unknown[] = [];
  const rpc = new JsonlRpcClient({ command: process.execPath, args: ['--input-type=module', '-e', prelude + `
    let received;
    lines.on('line', line => {
      const request=JSON.parse(line);
      if(request.method==='notify')received=request;
      else {send({method:'event',params:{accepted:true}});send({id:request.id,result:received});}
    });
  `], deadlineMs: 3000, onNotification: message => notifications.push(message) });
  try {
    await rpc.notify('notify', { synthetic: true });
    assert.deepEqual(await rpc.request('check'), { method: 'notify', params: { synthetic: true } });
    assert.deepEqual(notifications, [{ method: 'event', params: { accepted: true } }]);
  } finally { await rpc.close(); }
});

test('deadline is absolute across successful requests and kills a resistant child', async () => {
  const rpc = client(`
    process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);
    lines.on('line',line=>{const r=JSON.parse(line); if(r.method==='ready')send({id:r.id,result:process.pid});});
  `, 1000);
  const started = performance.now();
  const pid = await rpc.request<number>('ready');
  await assert.rejects(rpc.request('hang'), code('deadline'));
  await rpc.close();
  assert.ok(performance.now() - started < 2500);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(rpc.request('late'), code('deadline'));
});

test('close rejects pending requests and kills a resistant child', async () => {
  const rpc = client(`process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); lines.on('line',line=>{const r=JSON.parse(line);if(r.method==='pid')send({id:r.id,result:process.pid});});`);
  const pid = await rpc.request<number>('pid');
  const rejected = assert.rejects(rpc.request('hang'), code('closed'));
  await rpc.close();
  await rejected;
  await rpc.close();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

for (const [name, script, expected] of [
  ['malformed JSON', `process.stdout.write('bad\\n')`, 'protocol'],
  ['oversized partial line', `process.stdout.write('x'.repeat(1048577))`, 'protocol'],
  ['oversized complete line', `process.stdout.write('x'.repeat(1048577)+'\\n')`, 'protocol'],
  ['unknown response id', `send({id:999,result:'unexpected'})`, 'protocol'],
  ['ambiguous response', `send({id:1,result:true,error:{message:'private'}})`, 'protocol'],
  ['invalid error response', `send({id:1,error:null})`, 'protocol'],
  ['premature exit', `process.exit(0)`, 'exited'],
] as const) {
  test(`rejects ${name}`, async () => {
    const rpc = client(`lines.on('line',()=>{${script}});`);
    try { await assert.rejects(rpc.request('check'), code(expected)); }
    finally { await rpc.close(); }
  });
}

test('remote errors and stderr never leak into errors', async () => {
  const rpc = client(`lines.on('line',line=>{process.stderr.write('private-token'.repeat(100000));send({id:JSON.parse(line).id,error:{code:-32000,message:'private-token'}});});`);
  try {
    await assert.rejects(rpc.request('check'), error => {
      assert.ok(error instanceof RpcTransportError);
      assert.equal(error.code, 'remote');
      assert.equal(error.message.includes('private'), false);
      return true;
    });
  } finally { await rpc.close(); }
});

test('spawn failure is sanitized and cleanup completes', async () => {
  const rpc = new JsonlRpcClient({ command: '/missing/synthetic-executable', args: [], deadlineMs: 1000 });
  try { await assert.rejects(rpc.request('check'), error => error instanceof RpcTransportError && ['spawn', 'write'].includes(error.code)); }
  finally { await rpc.close(); }
});

test('rejects invalid timer and line bounds without spawning', () => {
  assert.throws(() => new JsonlRpcClient({ command: 'unused', args: [], deadlineMs: 0 }), RangeError);
  assert.throws(() => new JsonlRpcClient({ command: 'unused', args: [], deadlineMs: 1, maxLineBytes: 1048577 }), RangeError);
});
