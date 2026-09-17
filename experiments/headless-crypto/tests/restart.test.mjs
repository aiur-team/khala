import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, unlink, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
const run = (dir, op) => spawnSync(process.execPath, ['--import','tsx','src/main.ts',dir,op], {encoding:'utf8', timeout:15000});
test('native SQLite old self-event survives exit and SIGKILL; duplicates and missing/corrupt stores fail', async () => {
 await mkdir("stores", {recursive:true});
 const dir=await mkdtemp("stores/disposable-");
 try {
  const created=run(dir,'create'); assert.equal(created.status,0,created.stderr);
  const first=JSON.parse(created.stdout.trim());
  const restarted=run(dir,'read');assert.equal(restarted.status,0,restarted.stderr);
  const second=JSON.parse(restarted.stdout.trim());assert.deepEqual(first.identity,second.identity);assert.notEqual(first.pid,second.pid);
  const child=spawn(process.execPath,['--import','tsx','src/main.ts',dir,'hold'],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',code=>reject(new Error(`child exited ${code}`)));child.once('error',reject);});
  const duplicate=run(dir,'read');assert.notEqual(duplicate.status,0);assert.match(duplicate.stderr,/store locked/);
  const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await ended;
  assert.match(run(dir,'read').stderr,/interrupted shutdown/);
  await unlink(`${dir}/writer.lock`); // explicit recovery after observing child exit
  const abrupt=run(dir,'read');assert.equal(abrupt.status,0,abrupt.stderr);assert.deepEqual(JSON.parse(abrupt.stdout).identity,first.identity);
  const db=(await readdir(dir)).find(name=>name.endsWith('.sqlite3')||name.endsWith('.db'));
  assert.ok(db, 'native SQLite file found');
  await writeFile(`${dir}/${db}`,'corrupt fixture');
  assert.notEqual(run(dir,'read').status,0);
 } finally {await rm(dir,{recursive:true,force:true});}
 const missing=await mkdtemp("stores/missing-");
 try {assert.match(run(missing,'read').stderr,/missing identity/);} finally {await rm(missing,{recursive:true,force:true});}
});
