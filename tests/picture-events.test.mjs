import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {createPictureEvents} from '../host-picture-events.js';
import {createPictureHost} from '../host-pictures.js';
import {defaultDraw, parsePictures} from '../core/draw.js';
import {DrawQueue} from '../core/draw-queue.js';
import {RUNNINGHUB_URL} from '../core/runninghub.js';

function fixture() {
  const message = {mes: '<img>forest</img>\n<img>river</img>\n<img>mountain</img>',
    send_date: '2026-11-06T02:00:00.000Z', gen_started: '2026-11-06T01:59:00.000Z', swipe_id: 0};
  const ctx = {chat: [message], characterId: 1, groupId: null, chatId: 'fixture', name2: 'Fixture'};
  return {ctx, message};
}

for (const engine of ['gpt', 'comfy']) {
  test(engine + ' receives a completed reply, generates three pictures and survives cloned metadata without a rendered event', async t => {
    const {ctx, message} = fixture(), requests = [], uploads = [], saved = [];
    const draw = {...defaultDraw(), enabled: true, auto: true, mode: 'inline', engine};
    draw.gpt.ask = false;
    draw.comfy.url = RUNNINGHUB_URL;
    ctx.getRequestHeaders = () => ({});
    ctx.saveChat = async () => { saved.push(structuredClone(ctx.chat)); };
    const backend = {
      drawQueue: new DrawQueue({concurrency: () => 2}), drawReady: () => true, drawQuote: () => ({free: true}),
      base64: blob => blob.text(),
      generateImage(input) {
        return this.drawQueue.add({key: input.key, channel: engine === 'gpt' ? 'gpt' : 'runninghub', task: () => {
          assert.equal(input.valid(), true);
          return new Promise(resolve => requests.push({input, finish() {
            resolve({blob: new Blob([input.prompt]), photoId: input.prompt, seed: -1, params: input.params});
          }}));
        }});
      },
    };
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, '/api/images/upload');
      const body = JSON.parse(init.body); uploads.push(body);
      return Response.json({path: 'user/images/' + body.filename + '.png'});
    });
    const host = createPictureHost({context: () => ctx, settings: () => ({draw, routes: [], general: {}}),
      backend, marker: 'event-test', scheduleRender() {}, notice: assert.fail});
    const events = createPictureEvents({context: () => ctx, autoPictures: id => host.autoPictures(id), notice: assert.fail});
    const pending = events.received(0, 'normal');
    ctx.chat.splice(0, 1, structuredClone(message));
    await tick();
    assert.equal(requests.length, 2);
    assert.equal(events.received(0, 'normal'), undefined);
    requests[1].finish();
    await tick();
    assert.equal(requests.length, 3);
    requests[0].finish(); requests[2].finish();
    await pending;
    assert.equal(uploads.length, 3);
    assert.equal(saved.length, 3);
    assert.equal(Object.keys(ctx.chat[0].extra.sttts_pics).length, 3);
    for (const tag of parsePictures(message.mes)) assert.ok(ctx.chat[0].extra.sttts_pics[tag.hash]);
    delete ctx.chat[0].extra.sttts_pics;
    await events.received(0, 'normal');
    assert.equal(requests.length, 3);
  });
}

test('failed or cancelled attempts cannot restart on duplicate received events', async () => {
  for (const cancelled of [false, true]) {
    const {ctx} = fixture(), notices = [];
    let calls = 0;
    const events = createPictureEvents({context: () => ctx, autoPictures() {
      calls++;
      throw Object.assign(Error('fixture failure'), {cancelled});
    }, notice: text => notices.push(text)});
    await events.received(0, 'normal');
    ctx.chat = structuredClone(ctx.chat);
    await events.received(0, 'normal');
    assert.equal(calls, 1);
    assert.equal(notices.length, cancelled ? 0 : 1);
  }
});

test('quiet and impersonation calls, history without an event, and user or system messages do not generate pictures', async () => {
  const {ctx} = fixture();
  let calls = 0;
  const events = createPictureEvents({context: () => ctx, autoPictures: () => { calls++; }});
  await tick();
  await events.received(0, 'quiet');
  await events.received(0, 'impersonate');
  await events.received(undefined, 'normal');
  ctx.chat[0].is_user = true;
  await events.received(0, 'normal');
  ctx.chat[0].is_user = false; ctx.chat[0].is_system = true;
  await events.received(0, 'normal');
  assert.equal(calls, 0);
  ctx.chat[0].is_system = false;
  await events.received(0, 'normal');
  assert.equal(calls, 1);
});

test('a delayed received task refuses a different chat or swipe and accepts the next real reply', async () => {
  const {ctx} = fixture();
  let calls = 0;
  const events = createPictureEvents({context: () => ctx, autoPictures: () => { calls++; }});
  const stale = events.received(0, 'normal');
  ctx.characterId = 2;
  await stale;
  assert.equal(calls, 0);
  await events.received(0, 'normal');
  assert.equal(calls, 1);
  ctx.chat[0].swipe_id = 1;
  await events.received(0, 'swipe');
  assert.equal(calls, 2);
  ctx.chat[0].gen_started = '2026-11-06T02:10:00.000Z';
  await events.received(0, 'appendFinal');
  assert.equal(calls, 3);
});

test('group replies are independent while a speaker change does not repeat a previous reply', async () => {
  const {ctx, message} = fixture(), ids = [];
  ctx.groupId = 'group';
  ctx.chat.push({...message, send_date: '2026-11-06T02:01:00.000Z'});
  const events = createPictureEvents({context: () => ctx, autoPictures: id => { ids.push(id); }});
  await events.received(0, 'normal');
  ctx.characterId = 2;
  await events.received(1, 'normal');
  await events.received(0, 'normal');
  assert.deepEqual(ids, [0, 1]);
});

test('chat changes and disposal invalidate pending dispatches before the next host can be called', async () => {
  const {ctx} = fixture();
  let calls = 0;
  const events = createPictureEvents({context: () => ctx, autoPictures: () => { calls++; }});
  const oldChat = events.received(0, 'normal');
  events.reset();
  await oldChat;
  assert.equal(calls, 0);
  const oldSession = events.received(0, 'normal');
  events.dispose();
  await oldSession;
  await events.received(0, 'normal');
  assert.equal(calls, 0);
});
