import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createPictureHost} from '../host-pictures.js';
import {defaultDraw, parsePictures} from '../core/draw.js';
import {DrawQueue} from '../core/draw-queue.js';
import {RUNNINGHUB_URL} from '../core/runninghub.js';

const message = () => ({mes: '<img>forest</img>\n<img>river</img>'});
function setup(t, engine, url = '') {
  const floor = message(), requests = [], uploads = [], saved = [];
  const draw = {...defaultDraw(), engine};
  draw.comfy.url = url;
  const ctx = {chat: [floor], getCurrentChatId: () => 'first', name2: 'First', getRequestHeaders: () => ({}),
    saveChat: async () => { saved.push(structuredClone(ctx.chat)); }};
  let current = ctx;
  const backend = {
    drawReady: () => true, drawQuote: () => ({free: true}), base64: blob => blob.text(),
    generateImage(input) {
      return new Promise(resolve => requests.push({input, finish: () => resolve({
        blob: new Blob([input.prompt]), photoId: input.prompt, seed: -1, params: input.params
      })}));
    }
  };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, '/api/images/upload');
    const body = JSON.parse(init.body);
    uploads.push(body);
    return Response.json({path: 'user/images/' + body.filename + '.png'});
  });
  const host = createPictureHost({context: () => current, settings: () => ({draw, routes: [], general: {}}),
    backend, marker: 'story-test', scheduleRender() {}, notice: assert.fail});
  return {host, backend, ctx, floor, requests, uploads, saved, switchChat() {
    current = {...ctx, chat: [message()], name2: 'Second', getCurrentChatId: () => 'second'};
    return current;
  }};
}

for (const [channel, engine, url] of [['GPT', 'gpt', ''], ['RunningHub', 'comfy', RUNNINGHUB_URL]]) {
  test(channel + ' floor batches submit together, preserve tag ownership and serialize chat saves', async t => {
    const {host, ctx, floor, requests, uploads, saved} = setup(t, engine, url);
    const tags = parsePictures(floor.mes), submit = host.drawMessage(0);
    await tick();
    assert.equal(requests.length, 2);
    await host.drawMessage(0);
    assert.equal(requests.length, 2);
    let finishSave;
    const save = ctx.saveChat;
    ctx.saveChat = async () => {
      await save();
      if (saved.length === 1) await new Promise(resolve => { finishSave = resolve; });
    };
    t.mock.method(Date, 'now', () => 1000);
    requests[1].finish();
    await tick();
    requests[0].finish();
    await tick();
    assert.equal(uploads.length, 2);
    assert.notEqual(uploads[0].filename, uploads[1].filename);
    assert.equal(saved.length, 1);
    assert.deepEqual(Object.keys(saved[0][0].extra.sttts_pics), [tags[1].hash]);
    finishSave();
    await submit;
    const records = saved[1][0].extra.sttts_pics;
    tags.forEach((tag, i) => assert.equal(records[tag.hash].versions[0].photoId, requests[i].input.prompt));
  });

  test(channel + ' story placeholder distinguishes the first picture on a new floor from the two active jobs', async t => {
    const {host, backend, ctx, requests} = setup(t, engine, url);
    const nextFloor = {mes: '<img>summit</img>'};
    ctx.chat.push(nextFloor);
    const [tag] = parsePictures(nextFloor.mes);
    const placeholder = {dataset: {stttsToken: 'story-test', stttsHash: tag.hash}, toggleAttribute() {}};
    const element = {getAttribute: () => '1', querySelectorAll: () => [placeholder]};
    const previousDocument = globalThis.document;
    globalThis.document = {querySelectorAll: () => [element]};
    t.after(() => {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    });
    backend.drawQueue = new DrawQueue({concurrency: () => 2});
    const makeImage = backend.generateImage;
    backend.generateImage = input => backend.drawQueue.add({key: input.key, channel: channel.toLowerCase(), task: () => makeImage(input)});
    let finishUpload;
    backend.base64 = async blob => {
      const text = await blob.text();
      if (text.includes('summit')) await new Promise(resolve => { finishUpload = resolve; });
      return text;
    };
    const render = () => { host.decorate(() => true); return placeholder.innerHTML; };
    const earlier = host.drawMessage(0);
    await tick();
    const later = host.drawMessage(1);
    await tick();
    assert.equal(requests.length, 2);
    assert.match(render(), /本楼第 1 张/);
    assert.match(placeholder.innerHTML, new RegExp(channel));
    assert.match(placeholder.innerHTML, /候补第 1 张/);
    requests[0].finish();
    await tick();
    assert.equal(requests.length, 3);
    assert.match(render(), /本楼第 1 张/);
    assert.match(placeholder.innerHTML, new RegExp(channel));
    assert.match(placeholder.innerHTML, /正在画/);
    assert.doesNotMatch(placeholder.innerHTML, /候补/);
    requests[1].finish();
    requests[2].finish();
    await tick();
    assert.match(render(), /本楼第 1 张.*正在保存/);
    finishUpload();
    await Promise.all([earlier, later]);
  });
}

test('switching chats invalidates queued story requests and prevents stale uploads or saves', async t => {
  const {host, requests, uploads, saved, floor, switchChat} = setup(t, 'comfy', RUNNINGHUB_URL);
  const submit = host.drawMessage(0);
  await tick();
  assert.equal(requests.length, 2);
  const other = switchChat();
  for (const request of requests) {
    assert.equal(request.input.valid(), false);
    request.finish();
  }
  await submit;
  assert.equal(uploads.length, 0);
  assert.equal(saved.length, 0);
  assert.equal(floor.extra, undefined);
  assert.equal(other.chat[0].extra, undefined);
});

test('a thinking-block image example never enters the story drawing queue', async t => {
  const {host, floor, requests, saved} = setup(t, 'comfy', RUNNINGHUB_URL);
  floor.mes = '<think_nya>Use <img>...</img> for pictures.</think_nya>\n<game>' + floor.mes + '</game>';
  const submit = host.drawMessage(0);
  await tick();
  assert.equal(requests.length, 2);
  assert.match(requests[0].input.label, /第 1 张/);
  assert.match(requests[1].input.label, /第 2 张/);
  requests.forEach(request => request.finish());
  await submit;
  assert.equal(Object.keys(saved.at(-1)[0].extra.sttts_pics).length, 2);
});

test('native ComfyUI floor batches submit the next tag after the previous one finishes', async t => {
  const {host, requests, saved} = setup(t, 'comfy', 'http://localhost:8188');
  const submit = host.drawMessage(0);
  await tick();
  assert.equal(requests.length, 1);
  requests[0].finish();
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(saved.length, 1);
  requests[1].finish();
  await submit;
  assert.equal(saved.length, 2);
});
