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
  return {host, backend, draw, ctx, floor, requests, uploads, saved, switchChat() {
    current = {...ctx, chat: [message()], name2: 'Second', getCurrentChatId: () => 'second'};
    return current;
  }};
}

function automaticBatch(t, engine, url, identity = true) {
  const fixture = setup(t, engine, url);
  const {backend, draw, ctx, floor} = fixture;
  Object.assign(draw, {enabled: true, auto: true, mode: 'inline'});
  Object.assign(ctx, {characterId: 1, groupId: null});
  Object.assign(floor, {mes: '<img>forest</img>\n<img>river</img>\n<img>mountain</img>', swipe_id: 0, extra: {}});
  if (identity) Object.assign(floor, {send_date: '2026-11-06T01:10:00.000Z', gen_started: '2026-11-06T01:09:00.000Z'});
  backend.drawQueue = new DrawQueue({concurrency: () => 2});
  const makeImage = backend.generateImage;
  backend.generateImage = input => backend.drawQueue.add({
    key: input.key, channel: engine === 'gpt' ? 'gpt' : 'runninghub', task() {
      if (!input.valid()) throw Object.assign(Error('Message changed'), {cancelled: true});
      return makeImage(input);
    },
  });
  return fixture;
}

for (const [channel, engine, url] of [['GPT', 'gpt', ''], ['RunningHub', 'comfy', RUNNINGHUB_URL]]) {
  test(channel + ' automatic pictures survive full-chat metadata replacement and save to the latest objects', async t => {
    const {host, backend, ctx, floor, requests, uploads, saved} = automaticBatch(t, engine, url);
    if (engine === 'gpt') {
      floor.send_date = new Date(floor.send_date);
      floor.gen_started = new Date(floor.gen_started);
    }
    const tags = parsePictures(floor.mes), automatic = host.autoPictures(0), originalArray = ctx.chat;
    await tick();
    assert.equal(requests.length, 2);
    const clone = JSON.parse(JSON.stringify(ctx.chat));
    clone[0].TavernDB_ACU_IsolatedData = {fixture: 'first metadata update'};
    ctx.chat.length = 0;
    ctx.chat.push(...clone);
    assert.equal(ctx.chat, originalArray);
    assert.notEqual(ctx.chat[0], floor);

    requests[1].finish();
    await tick();
    assert.equal(requests.length, 3);
    assert.equal(saved.length, 1);
    assert.ok(ctx.chat[0].extra.sttts_pics[tags[1].hash]);

    let resumeUpload;
    backend.base64 = async blob => {
      const text = await blob.text();
      if (text.includes('mountain')) await new Promise(resolve => { resumeUpload = resolve; });
      return text;
    };
    requests[2].finish();
    await tick();
    assert.equal(typeof resumeUpload, 'function');
    const nextClone = JSON.parse(JSON.stringify(ctx.chat));
    nextClone[0].TavernDB_ACU_IsolatedData = {fixture: 'second metadata update'};
    ctx.chat.length = 0;
    ctx.chat.push(...nextClone);
    resumeUpload();
    requests[0].finish();
    await automatic;
    assert.equal(uploads.length, 3);
    assert.equal(saved.length, 3);
    assert.equal(backend.drawQueue.pending, false);
    assert.equal(floor.extra.sttts_pics, undefined);
    const records = ctx.chat[0].extra.sttts_pics;
    assert.equal(Object.keys(records).length, 3);
    tags.forEach((tag, index) => assert.equal(records[tag.hash].versions[0].photoId, requests[index].input.prompt));
    assert.deepEqual(saved.at(-1)[0].extra.sttts_pics, records);
    await host.autoPictures(0);
    assert.equal(requests.length, 3);
  });

  const replacements = [
    ['a different swipe', (ctx, replacement) => { replacement.swipe_id = 1; }],
    ['another character with the same chat filename', ctx => { ctx.characterId = 2; }],
    ['another group with the same chat filename', ctx => { ctx.groupId = 'another-group'; }],
    ['a different floor with identical picture prompts', (ctx, replacement) => { replacement.send_date = '2026-11-06T01:20:00.000Z'; }],
    ['a new generation on the same floor', (ctx, replacement) => { replacement.gen_started = '2026-11-06T01:19:00.000Z'; }],
  ];
  for (const [reason, change] of replacements) {
    test(channel + ' automatic pictures reject ' + reason, async t => {
      const {host, backend, ctx, floor, requests, uploads, saved} = automaticBatch(t, engine, url);
      const automatic = host.autoPictures(0);
      await tick();
      assert.equal(requests.length, 2);
      const replacement = structuredClone(floor);
      ctx.chat.splice(0, 1, replacement);
      change(ctx, replacement);
      for (const request of requests) {
        assert.equal(request.input.valid(), false);
        request.finish();
      }
      await automatic;
      assert.equal(requests.length, 2);
      assert.equal(uploads.length, 0);
      assert.equal(saved.length, 0);
      assert.equal(floor.extra.sttts_pics, undefined);
      assert.equal(replacement.extra.sttts_pics, undefined);
      assert.equal(backend.drawQueue.pending, false);
    });
  }

  test(channel + ' replacement without stable message identity is rejected', async t => {
    const {host, backend, ctx, floor, requests, uploads, saved} = automaticBatch(t, engine, url, false);
    const automatic = host.autoPictures(0);
    await tick();
    assert.equal(requests.length, 2);
    ctx.chat.splice(0, 1, structuredClone(floor));
    requests.forEach(request => request.finish());
    await automatic;
    assert.equal(requests.length, 2);
    assert.equal(uploads.length, 0);
    assert.equal(saved.length, 0);
    assert.equal(ctx.chat[0].extra.sttts_pics, undefined);
    assert.equal(backend.drawQueue.pending, false);
  });

  for (const nextSwipe of [0, 1]) {
    test(channel + (nextSwipe === 0
      ? ' automatic pictures survive first-swipe initialization while queued'
      : ' automatic pictures are cancelled when the user selects another swipe'), async t => {
      const {host, backend, draw, floor, requests, uploads, saved} = setup(t, engine, url);
      Object.assign(draw, {enabled: true, auto: true, mode: 'inline'});
      floor.mes = '<think_nya>Example <img>hidden</img></think_nya>\n<game>' + floor.mes + '</game>';
      backend.drawQueue = new DrawQueue({concurrency: () => 1});
      const makeImage = backend.generateImage;
      const route = channel.toLowerCase();
      backend.generateImage = input => backend.drawQueue.add({
        key: input.key, channel: route, task() {
          if (!input.valid()) throw Object.assign(Error('Message changed'), {cancelled: true});
          return makeImage(input);
        }
      });
      let finishEarlier;
      const earlier = backend.drawQueue.add({channel: route, task: () => new Promise(resolve => { finishEarlier = resolve; })});
      const automatic = host.autoPictures(0);
      await tick();
      assert.equal(floor.swipe_id, undefined);
      assert.equal(backend.drawQueue.list().length, 3);
      assert.equal(requests.length, 0);
      floor.swipe_id = nextSwipe;
      finishEarlier();
      await earlier;
      await tick();
      if (nextSwipe === 0) {
        assert.equal(requests.length, 1);
        requests[0].finish();
        await tick();
        assert.equal(requests.length, 2);
        requests[1].finish();
      }
      await automatic;
      assert.equal(requests.length, nextSwipe === 0 ? 2 : 0);
      assert.equal(uploads.length, nextSwipe === 0 ? 2 : 0);
      assert.equal(saved.length, nextSwipe === 0 ? 2 : 0);
    });
  }

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

test('automatic group pictures keep their group owner when the active speaker changes', async t => {
  const {host, backend, ctx, requests, uploads, saved} = automaticBatch(t, 'gpt');
  ctx.groupId = 'fixture-group';
  ctx.characters = [{avatar: 'unused.png'}, {avatar: 'first.png'}, {avatar: 'second.png'}];
  const automatic = host.autoPictures(0);
  await tick();
  assert.equal(requests.length, 2);
  ctx.characterId = 2;
  ctx.name2 = 'Second';
  assert.ok(requests.every(request => request.input.valid()));
  requests[1].finish();
  await tick();
  assert.equal(requests.length, 3);
  requests[2].finish();
  requests[0].finish();
  await automatic;
  assert.equal(saved.length, 3);
  assert.equal(uploads.length, 3);
  assert.ok(uploads.every(upload => upload.ch_name === 'First'));
  assert.equal(backend.drawQueue.pending, false);
});

for (const field of ['send_date', 'gen_started']) {
  test('changing ' + field + ' invalidates pictures even on the original message object', async t => {
    const {host, backend, floor, requests, uploads, saved} = automaticBatch(t, 'gpt');
    const automatic = host.autoPictures(0);
    await tick();
    assert.equal(requests.length, 2);
    floor[field] = '2026-11-06T02:00:00.000Z';
    for (const request of requests) {
      assert.equal(request.input.valid(), false);
      request.finish();
    }
    await automatic;
    assert.equal(requests.length, 2);
    assert.equal(saved.length, 0);
    assert.equal(uploads.length, 0);
    assert.equal(backend.drawQueue.pending, false);
  });
}

test('initializing an absent generation timestamp keeps automatic pictures valid', async t => {
  const {host, backend, floor, requests, saved} = automaticBatch(t, 'comfy', RUNNINGHUB_URL);
  delete floor.gen_started;
  const automatic = host.autoPictures(0);
  await tick();
  assert.equal(requests.length, 2);
  floor.gen_started = '2026-11-06T01:09:00.000Z';
  assert.ok(requests.every(request => request.input.valid()));
  requests[0].finish();
  await tick();
  assert.equal(requests.length, 3);
  requests[1].finish();
  requests[2].finish();
  await automatic;
  assert.equal(saved.length, 3);
  assert.equal(backend.drawQueue.pending, false);
});

for (const entry of ['autoPictures', 'drawMessage']) {
  for (const target of ['character', 'group', 'swipe']) {
    test(entry + ' captures its target before awaiting permission (' + target + ')', async t => {
      const {host, backend, ctx, requests, uploads, saved} = automaticBatch(t, 'gpt');
      ctx.characters = [{avatar: 'unused.png'}, {avatar: 'first.png'}, {avatar: 'second.png'}];
      if (target === 'group') ctx.groupId = 'first-group';
      const automatic = host[entry](0);
      assert.equal(requests.length, 0);
      if (target === 'group') ctx.groupId = 'second-group';
      else if (target === 'character') ctx.characterId = 2;
      else ctx.chat[0].swipe_id = 1;
      await tick();
      assert.equal(requests.length, 0);
      await automatic;
      assert.equal(uploads.length, 0);
      assert.equal(saved.length, 0);
      assert.equal(backend.drawQueue.pending, false);
    });
  }
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
