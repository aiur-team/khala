import {chromium,type BrowserContext,type Page} from 'playwright';
let context:BrowserContext;
let page:Page;
process.on('message',async(message:any)=>{
 try {
  let result:any;
  if(message.op==='open'){
   context=await chromium.launchPersistentContext(message.profile,{executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
   page=await context.newPage();await page.goto(message.url);await page.waitForFunction(()=>!!(window as any).runtime);
   const keys=await page.evaluate(config=>(window as any).runtime.open(config),message.config);
   result={pid:process.pid,keys};
  }else if(message.op==='close'){
   await page.evaluate(()=>(window as any).runtime.close());await context.close();process.send?.({id:message.id,result:true});process.exit(0);
  }else{
   result=await page.evaluate(({op,args})=>(window as any).runtime[op](...args),{op:message.op,args:message.args??[]});
  }
  process.send?.({id:message.id,result});
 }catch(error){process.send?.({id:message.id,error:error instanceof Error?error.message:'runtime operation failed'});}
});
// Parent disconnection must not leave a browser holding the owner profile.
process.on('disconnect',async()=>{await context?.close();process.exit(0);});
