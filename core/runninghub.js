// RunningHub's cloud workflow, using the tavern's network transport; no local ComfyUI.
export const RUNNINGHUB_URL = 'https://www.runninghub.ai';
export const isRunningHub = url => /^https:\/\/(?:www\.)?runninghub\.ai\/?$/.test(String(url || ''));
const WORKFLOW_ID = '2115286699248189441';
const ORIGINAL = 'RunningHubQwenXianxia';
const RETIRED = 'RunningHubQwenXianxiaHauhau';
const graphOf = value => typeof value === 'string' ? JSON.parse(value) : value;
export function runningHubRoute(workflow) {
  const graph = graphOf(workflow);
  const nodes = Object.values(graph || {}).filter(n => n?.class_type === ORIGINAL);
  if (nodes.length !== 1 || Object.values(graph || {}).some(n => n?.class_type === RETIRED)) throw Error('RunningHub 直连请选择仙侠原版（不扩写）方案');
  return {node: nodes[0], workflowId: WORKFLOW_ID, model: 'RunningHub · Qwen Image 2.1（不扩写）'};
}
// 删除已退役的扩写方案；仅有旧方案时将其参数迁移到原版，保留普通 ComfyUI 方案。
export function retireExpandedWorkflow(comfy) {
  const hasRetired = row => { try { return Object.values(graphOf(row.workflow) || {}).some(n => n?.class_type === RETIRED); } catch { return false; } };
  const retired = comfy.workflows.filter(hasRetired);
  if (!retired.length) return false;
  let original = comfy.workflows.find(row => { try { runningHubRoute(row.workflow); return true; } catch { return false; } });
  if (!original) {
    const old = retired.find(row => row.id === comfy.activeWorkflow) || retired[0];
    const graph = graphOf(old.workflow);
    for (const node of Object.values(graph)) if (node?.class_type === RETIRED) { node.class_type = ORIGINAL; delete node.inputs.max_tokens; delete node.inputs.temperature; }
    original = {...old, name: 'Qwen Image 2.1（不扩写）', workflow: JSON.stringify(graph)};
    delete original.sourceWorkflow;
  }
  comfy.workflows = comfy.workflows.filter(row => !hasRetired(row));
  if (!comfy.workflows.some(row => row.id === original.id)) comfy.workflows.push(original);
  if (retired.some(row => row.id === comfy.activeWorkflow)) comfy.activeWorkflow = original.id;
  return true;
}
const BLUSH_NEGATIVE = 'heavy blush, excessive blush, intense facial flushing, bright red cheeks, broad red patches under eyes, thick red eyeshadow, exaggerated rouge, painted red cheek stripes';
const SKIN = 'Natural even facial skin tone; any emotional blush is faint and localized, with no saturated red patches across the cheeks or beneath the eyes.';

export function runningHubFields(workflow) {
  const {node} = runningHubRoute(workflow);
  const p = node.inputs;
  if (!String(p.prompt || '').trim()) throw Error('请填写人物和场景描述');
  for (const key of ['width', 'height']) if (!Number.isInteger(p[key]) || p[key] < 64 || p[key] > 4096 || p[key] % 32) throw Error('画面宽高须为 64–4096 之间、32 的倍数');
    // Match the old bridge's skin-tone correction without invoking an expansion model.
    const strong = '(?:heavy|intense|extreme|excessive|strong|deep|bright red|very strong|pronounced)\\s+(?:blush(?:ing)?|facial flushing|rouge)|(?:bright|deep|intensely)\\s+red\\s+cheeks';
    let prompt = p.prompt.replace(new RegExp('\\(\\s*(?:'+strong+'|blush(?:ing)?)\\s*:\\s*[\\d.]+\\s*\\)','gi'),'faint natural blush')
      .replace(new RegExp('\\b(?:'+strong+')\\b','gi'),'faint natural blush')
      .replace(/\b(?:heavy_blush|intense_blush|full_face_blush)\b/gi,'faint natural blush')
      .replace(/满脸通红|面红耳赤|重度脸红|强烈脸红|夸张腮红|大片腮红|浓重腮红/g,'轻微自然泛红');
    if (!prompt.includes(SKIN)) prompt += '\n'+SKIN;
    return [['4','prompt',prompt],['4','negative_prompt',[p.negative_prompt,BLUSH_NEGATIVE].filter(Boolean).join(', ')],
      ['5','width',p.width],['5','height',p.height],['5','batch_size',1],['6','seed',p.seed],['6','steps',p.steps ?? 30],
      ['6','cfg',p.cfg ?? 2.5],['9','strength_model',p.lora_strength ?? .5],['9','strength_clip',0]]
      .map(([nodeId,fieldName,fieldValue])=>({nodeId,fieldName,fieldValue}));
}

function pause(ms, signal) {
  return new Promise((resolve,reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('已取消','AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort',abort); resolve(); },ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}

export async function runningHubGenerate({fetch = globalThis.fetch, key, workflow, signal, pollMs = 2500, timeoutMs = 900000, onTask = () => {}}) {
  if (!key) throw Error('请先导入 RunningHub API 密钥');
  const fields = runningHubFields(workflow);
  const route = runningHubRoute(workflow);
  const api = async (path, payload, abort = signal) => {
    const response = await fetch(RUNNINGHUB_URL + path, {
      method:'POST', credentials:'omit', headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},
      body:JSON.stringify({...payload,apiKey:key}), signal: abort ? AbortSignal.any([abort,AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000)
    });
    if (!response.ok) throw Error(`RunningHub 请求失败（HTTP ${response.status}）`);
    const data = await response.json();
    if (!data || typeof data.code !== 'number') throw Error('RunningHub 返回格式无效');
    return data;
  };
  let taskId = '', complete = false;
  try {
    // Never retry task creation automatically: the first request may already have been accepted.
    const submitted = await api('/task/openapi/create',{workflowId:route.workflowId,instanceType:'default',nodeInfoList:fields});
    if (submitted.code !== 0) throw Error(`RunningHub 提交失败（${submitted.code}）：${String(submitted.msg || '').slice(0,160)}`);
    taskId = String(submitted.data?.taskId || '');
    if (!taskId) throw Error('RunningHub 未返回任务编号，请先检查云端任务列表再重试');
    onTask(taskId);
    const tips = typeof submitted.data.promptTips === 'string' ? JSON.parse(submitted.data.promptTips || '{}') : submitted.data.promptTips;
    if (tips?.result === false || Object.keys(tips?.node_errors || {}).length) throw Error('RunningHub 云工作流校验失败，请检查节点配置');
    const deadline = Date.now()+timeoutMs;
    while (Date.now()<deadline) {
      signal?.throwIfAborted();
      const result = await api('/task/openapi/outputs',{taskId});
      if (result.code === 0) {
        complete = true;
        const item = result.data?.find(x => String(x.nodeId)==='10' && /^(png|jpe?g|webp)$/i.test(x.fileType));
        if (!item?.fileUrl) throw Error(`云任务 ${taskId} 已结束，但没有保存图片`);
        const url = new URL(item.fileUrl);
        if (url.protocol!=='https:' || url.username || url.password) throw Error('云端图片地址无效');
        // Do not send the API credential to the output CDN.
        const response = await fetch(url.href, {credentials:'omit',signal});
        if (!response.ok) throw Error(`云任务 ${taskId} 已完成，图片下载失败（${response.status}），可从 RunningHub 取回`);
        const blob = await response.blob(), bytes = new Uint8Array(await blob.slice(0,12).arrayBuffer());
        const png = [137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v), jpg = bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
        const webp = String.fromCharCode(...bytes.slice(0,4))==='RIFF' && String.fromCharCode(...bytes.slice(8,12))==='WEBP';
        if (!png&&!jpg&&!webp) throw Error(`云任务 ${taskId} 返回的文件不是图片`);
        return {blob:new Blob([blob],{type:png?'image/png':jpg?'image/jpeg':'image/webp'}),taskId,cost:item.consumeCoins,model:route.model};
      }
      if (![804,813].includes(result.code)) { complete = true; throw Error(`RunningHub 任务 ${taskId} 失败（${result.code}）：${String(result.data?.failedReason?.exception_message || result.msg || '').slice(0,180)}`); }
      await pause(pollMs,signal);
    }
    throw Error(`RunningHub 任务 ${taskId} 等待超时，已请求取消；请在云端确认状态`);
  } finally {
    if (taskId&&!complete) {
      try { await api('/task/openapi/cancel',{taskId},null); }
      catch { /* Keep the original error; task ID is reported via onTask. */ }
    }
  }
}
