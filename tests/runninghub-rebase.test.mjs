import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {activeLoraWorkflow} from '../core/comfy-loras.js';
import {keepOneOutput, switchNodesOff} from '../core/comfy-graph.js';
import {comfyPrompt, comfyValues, fillWorkflow, DRAW_ENGINE_NAMES} from '../core/image-engines.js';
import {isRunningHub, runningHubGenerate, RUNNINGHUB_URL} from '../core/runninghub.js';
const source = fs.readFileSync(new URL('../core/backend.js', import.meta.url), 'utf8');
const method = source.slice(source.indexOf('    async drawWithEngine('), source.indexOf('    /** How a picture was drawn'));
const workflow = JSON.stringify({a:{class_type:'RunningHubQwenXianxia',inputs:{prompt:'%prompt%',negative_prompt:'%negative_prompt%',width:'%width%',height:'%height%',seed:'%seed%'}}});
test('rebased cloud path uses upstream workflow shaping without opening a ComfyUI websocket', async () => {
 const context = vm.createContext({isRunningHub, runningHubGenerate, activeLoraWorkflow, keepOneOutput, switchNodesOff, comfyPrompt, comfyValues, fillWorkflow, Math,
  comfyProgress: () => assert.fail('Cloud tasks must not open ComfyUI progress connections'),
  comfyGenerate: () => assert.fail('Cloud tasks must not use the ComfyUI proxy')});
 const Backend = vm.runInContext('class Backend {' + method + '} Backend', context);
 const backend = new Backend();
 backend.settings = {draw:{comfy:{url:RUNNINGHUB_URL,workflow,width:1024,height:1024,steps:30,scale:2.5,sampler:'euler'},styles:[]}};
 backend.keyStore = {load:()=>new Map([['runninghub','fixture-key']])};
 backend.comfyTavernValues = async () => ({});
 backend.emit = () => {};
 const urls = [];
 backend.imageFetch = async (url, init) => {
  urls.push(url);
  const json = value => Response.json(value);
  if (url.endsWith('/create')) { const body=JSON.parse(init.body); assert.equal(body.nodeInfoList.find(x=>x.fieldName==='width').fieldValue,1024); return json({code:0,data:{taskId:'test',promptTips:'{}'}}); }
  if (url.endsWith('/outputs')) return json({code:0,data:[{nodeId:'10',fileType:'png',fileUrl:'https://cdn.example/a.png'}]});
  assert.equal(init.headers,undefined);
  return new Response(new Uint8Array([137,80,78,71,13,10,26,10]));
 };
 const result=await backend.drawWithEngine('comfy',{prompt:'a quiet courtyard',negative:'text',characters:[],quote:{params:{width:1024,height:1024,seed:42}}});
 assert.equal(result.blob.type,'image/png'); assert.equal(result.seed,42); assert.equal(urls.length,3);
});
test('native ComfyUI still uses its proxy and stops progress subscription', async () => {
 let stopped=false, generated=false;
 const context=vm.createContext({isRunningHub, activeLoraWorkflow, keepOneOutput, switchNodesOff, comfyPrompt, comfyValues, fillWorkflow, Math,
  comfyProgress:()=>()=>{stopped=true;}, comfyGenerate:async()=>{generated=true;return new Blob(['native']);},
  runningHubGenerate:()=>assert.fail('Native ComfyUI must not call RunningHub')});
 const Backend=vm.runInContext('class Backend {'+method+'} Backend',context), b=new Backend();
 b.settings={draw:{comfy:{url:'http://localhost:8188',workflow},styles:[]}}; b.comfyTavernValues=async()=>({}); b.tavernHeaders=()=>({}); b.emit=()=>{};
 await b.drawWithEngine('comfy',{prompt:'scene',negative:'',characters:[],quote:{params:{width:1024,height:1024,seed:42}}});
 assert.equal(generated,true);assert.equal(stopped,true);
});
test('card name remains ComfyUI; importing a key preserves the selected workflow', () => {
 assert.equal(DRAW_ENGINE_NAMES.comfy,'ComfyUI');
 const ui=fs.readFileSync(new URL('../ui/draw.js',import.meta.url),'utf8');
 const handler=ui.slice(ui.indexOf("v.on('change', '[data-runninghub-key]'"),ui.indexOf("v.on('input', '[data-field]'"));
 assert.ok(handler.includes('runningHubRoute(state().comfy.workflow)'));
 assert.ok(!handler.includes('selectComfyWorkflow'));
});
