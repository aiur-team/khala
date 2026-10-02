import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {validId, log} from './state.mjs';
for await (const line of readline.createInterface({input:process.stdin})) {
  try {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result;
    if (request.method === 'initialize') result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'khala_spike',version:'0.1.0'}};
    else if (request.method === 'ping') result={};
    else if (request.method === 'tools/list') result={tools:[{name:'khala_spike_probe',description:'Record synthetic session environment evidence',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
    else if (request.method === 'tools/call' && request.params.name === 'khala_spike_probe') {
      // Deliberately inspect the default root even if XDG_STATE_HOME was stripped.
      const root=path.join(process.env.HOME || '', '.local/state/khala/codex');
      for (const id of fs.existsSync(root) ? fs.readdirSync(root).filter(validId) : []) {
        const dir=path.join(root,id);
        if (fs.statSync(dir).isDirectory()) log(dir,{role:'mcp-probe',metaThreadId:request.params._meta?.threadId ?? null,envThreadId:process.env.CODEX_THREAD_ID ?? null,xdgStateHome:process.env.XDG_STATE_HOME ?? null,home:process.env.HOME ?? null});
      }
      result={content:[{type:'text',text:'probe recorded'}]};
    } else { console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}}));continue; }
    console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  } catch { process.stderr.write('invalid probe request\n'); }
}
