import test from 'node:test';
import assert from 'node:assert/strict';
import {runningHubFields,runningHubGenerate} from '../core/runninghub.js';
const workflow={a:{class_type:'RunningHubQwenXianxia',inputs:{prompt:'watercolor, an adult in a courtyard',negative_prompt:'text',width:1024,height:1024,seed:42}}};
const json=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
const ok={code:0,data:{taskId:'123',promptTips:'{}'}};
test('preserves scene, separates style, maps controls and rejects incompatible workflow',()=>{
 const fields=runningHubFields(workflow,[{positive:'watercolor'}]);
 assert.match(fields.find(x=>x.fieldName==='prompt').fieldValue,/watercolor, an adult in a courtyard/);
 assert.ok(fields.every(x=>!['13','14','15','18'].includes(x.nodeId)));
 assert.match(fields.find(x=>x.fieldName==='negative_prompt').fieldValue,/text, heavy blush/);
 assert.throws(()=>runningHubFields({}),/仙侠/);
 assert.throws(()=>runningHubFields({a:{...workflow.a,inputs:{...workflow.a.inputs,width:1001}}}),/倍数/);
});
test('one cloud submission, polling and unauthenticated image download',async()=>{
 const calls=[];let polls=0;
 const result=await runningHubGenerate({key:'test-key',workflow,pollMs:1,fetch:async(url,init)=>{
 calls.push([decodeURIComponent(url),init]);
 if(url.includes('create'))return json(ok);
 if(url.includes('outputs'))return json(++polls===1?{code:804}:{code:0,data:[{nodeId:'10',fileType:'png',fileUrl:'https://cdn.example/image.png',consumeCoins:15}]});
 return new Response(new Uint8Array([137,80,78,71,13,10,26,10]));
 }});
 assert.equal(result.taskId,'123');assert.equal(result.blob.type,'image/png');assert.equal(result.cost,15);
 assert.equal(calls.filter(x=>x[0].includes('create')).length,1);
 assert.equal(calls.at(-1)[1].headers,undefined);
 assert.ok(calls.every(x=>!x[0].includes('8188')));
});
test('abort cancels submitted task exactly once',async()=>{
 const c=new AbortController();const paths=[];
 await assert.rejects(runningHubGenerate({key:'test',workflow,signal:c.signal,pollMs:1,fetch:async(url)=>{
 paths.push(url);if(url.includes('create'))return json(ok);
 if(url.includes('outputs')){c.abort();return json({code:813});}
 return json({code:0});
 }}),{name:'AbortError'});
 assert.equal(paths.filter(x=>x.includes('cancel')).length,1);
});
test('uncertain create is not retried',async()=>{let count=0;await assert.rejects(runningHubGenerate({key:'test',workflow,fetch:async()=>{count++;throw Error('network');}}));assert.equal(count,1);});
test('cancelling during create waits for the task ID and cancels it without polling', async () => {
 const controller = new AbortController(), calls = [];
 let reply;
 const job = runningHubGenerate({key: 'fixture', workflow, signal: controller.signal, fetch: (url, init) => {
   calls.push(url);
   if (url.endsWith('/create')) return new Promise((resolve, reject) => {
     init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true});
     reply = resolve;
   });
   assert.ok(url.endsWith('/cancel'));
   assert.equal(JSON.parse(init.body).taskId, '123');
   return json({code: 0});
 }});
 controller.abort();
 reply(json(ok));
 await assert.rejects(job, {name: 'AbortError'});
 assert.equal(calls.length, 2);
});
test('validation rejection cancels and HTML output is rejected',async()=>{
 let cancelled=false;
 await assert.rejects(runningHubGenerate({key:'test',workflow,fetch:async(url)=>{if(url.includes('cancel')){cancelled=true;return json({code:0});}return json({code:0,data:{taskId:'123',promptTips:{result:false}}});}}),/校验/);
 assert.equal(cancelled,true);
 await assert.rejects(runningHubGenerate({key:'test',workflow,fetch:async(url)=>url.includes('create')?json(ok):url.includes('outputs')?json({code:0,data:[{nodeId:'10',fileType:'png',fileUrl:'https://cdn.example/image'}]}):new Response('<html>')}),/不是图片/);
});
test('diagnostics redact the new credential and key storage supports it',async()=>{
 const {RequestLog}=await import('../core/request-log.js');
 const {LocalKeyStore}=await import('../core/keys.js');
 const data=new Map(),store=new LocalKeyStore('test',()=>({getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}));
 store.save('runninghub','test-secret-value');assert.equal(store.load().get('runninghub'),'test-secret-value');
 const log=new RequestLog({secrets:()=>[...store.load().values()]});
 const out=JSON.stringify(log.clean({headers:{Authorization:'Bearer test-secret-value'},body:{apiKey:'test-secret-value'},message:'test-secret-value'}));
 assert.ok(!out.includes('test-secret-value'));
});
test('original workflow routes to its own cloud graph with full prompt and no expansion nodes',async()=>{
 const original={a:{class_type:'RunningHubQwenXianxia',inputs:{...workflow.a.inputs,prompt:'watercolor, adult woman, (heavy blush:1.3)'}}};
 const fields=runningHubFields(original,[{positive:'watercolor'}]);
 assert.match(fields.find(x=>x.fieldName==='prompt').fieldValue,/watercolor, adult woman, faint natural blush/);
 assert.ok(fields.every(x=>!['13','14','15','18'].includes(x.nodeId)));
 let body;
 await runningHubGenerate({key:'test',workflow:original,fetch:async(url,init)=>{
 if(url.includes('create')){body=JSON.parse(init.body);return json(ok);}
 if(url.includes('outputs'))return json({code:0,data:[{nodeId:'10',fileType:'png',fileUrl:'https://cdn.example/image'}]});
 return new Response(new Uint8Array([137,80,78,71,13,10,26,10]));
 }});
 assert.equal(body.workflowId,'2115286699248189441');
 const {runningHubRoute}=await import('../core/runninghub.js');
 assert.equal(runningHubRoute(workflow).workflowId,'2115286699248189441');
 assert.throws(()=>runningHubRoute({a:{...workflow.a,class_type:'RunningHubQwenXianxiaHauhau'}}),/不扩写/);
});
