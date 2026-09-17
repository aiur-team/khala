import type {ChildProcess} from 'node:child_process';

/** Subscribe before requesting shutdown; already exited workers need no action. */
export async function stopWorker(child:ChildProcess, graceMs=1000):Promise<void> {
 if(child.exitCode!==null||child.signalCode!==null)return;
 await new Promise<void>((resolve,reject)=>{
  let finished=false;
  const finish=(error?:Error)=>{
   if(finished)return;finished=true;
   clearTimeout(force);clearTimeout(deadline);
   child.off('exit',exited);child.off('error',failed);
   if(error)reject(error);else resolve();
  };
  const exited=()=>finish();
  const failed=(error:Error & {code?:string})=>{
   // Disconnect can race the child's own disconnect; escalation still applies.
   if(error.code!=='ERR_IPC_DISCONNECTED')finish(error);
  };
  const force=setTimeout(()=>child.kill('SIGKILL'),graceMs);
  const deadline=setTimeout(()=>finish(new Error('worker shutdown deadline')),graceMs+1000);
  child.once('exit',exited);child.on('error',failed);
  if(child.exitCode!==null||child.signalCode!==null){finish();return;}
  try {
   if(child.connected)child.disconnect();else child.kill('SIGTERM');
  }catch(error){failed(error as Error & {code?:string});}
 });
}

export async function cleanupWorkers(children:Iterable<ChildProcess>,cleanup:()=>Promise<void>):Promise<void>{
 try {
  const outcomes=await Promise.allSettled([...children].map(child=>stopWorker(child)));
  const failed=outcomes.find(result=>result.status==='rejected');
  if(failed?.status==='rejected')throw failed.reason;
 }finally{await cleanup();}
}
