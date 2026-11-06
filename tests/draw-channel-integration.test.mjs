import test from 'node:test';
import assert from 'node:assert/strict';
import {TTSBackend} from '../core/backend.js';
import {RUNNINGHUB_URL} from '../core/runninghub.js';

function fixture(fetch) {
  const keys = new Map(), photos = new Map();
  const backend = new TTSBackend({
    imageFetch: fetch,
    keyStore: {load: () => keys, save: (engine, value) => keys.set(engine, value)},
    library: {addPhoto: async photo => {
      const id = crypto.randomUUID();
      photos.set(id, photo);
      return {id};
    }},
  });
  return {backend, api: backend.api(), photos};
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('GPT batch uses saved limit, fills a freed slot, and stores each response with its own prompt', async () => {
  const requests = [];
  const {api, photos} = fixture(async (url, init) => {
    assert.match(url, /\/images\/generations$/);
    const body = JSON.parse(init.body);
    assert.equal(body.n, 1);
    return new Promise(resolve => requests.push({body, finish: text =>
      resolve(Response.json({data: [{b64_json: btoa(text)}]}))}));
  });
  api.saveDraw({engine: 'gpt', queue: {gptConcurrency: 1}});
  api.setKey('gpt', 'fixture');
  await assert.rejects(api.generateImage({prompt: 'unapproved'}), {code: 'PAID'});
  const names = ['first', 'second', 'third', 'fourth'];
  const jobs = names.map(prompt => api.generateImage({prompt, key: prompt, allowPaid: true}));
  assert.throws(() => api.saveDraw({engine: 'comfy'}), /排队/);
  assert.throws(() => api.setKey('gpt', 'other-fixture'), /排队/);
  assert.equal(requests.length, 1);
  api.saveDraw({queue: {gptConcurrency: 2}});
  assert.equal(requests.length, 2);
  assert.deepEqual(api.drawQueue().map(j => j.state), ['running', 'running', 'waiting', 'waiting']);
  requests[1].finish('second');
  await jobs[1];
  assert.equal(requests.length, 3);
  requests[2].finish('third');
  await jobs[2];
  assert.equal(requests.length, 4);
  requests[3].finish('fourth');
  requests[0].finish('first');
  const results = await Promise.all(jobs);
  assert.deepEqual(api.drawQueue(), []);
  assert.equal(photos.size, 4);
  for (const [i, {photoId, prompt}] of results.entries()) {
    assert.ok(prompt.includes(names[i]));
    assert.equal(await photos.get(photoId).blob.text(), names[i]);
  }
});

test('RunningHub cancels only the selected cloud task and starts the next picture after cleanup', async () => {
  const workflow = JSON.stringify({a: {class_type: 'RunningHubQwenXianxia', inputs: {
    prompt: '%prompt%', negative_prompt: '%negative_prompt%', width: '%width%', height: '%height%', seed: '%seed%',
  }}});
  const creates = [], polls = new Map(), cancelled = [];
  let finishCancel;
  const {api, photos} = fixture(async (url, init) => {
    if (url.startsWith('https://cdn.example/')) {
      assert.equal(init.headers, undefined);
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    const body = JSON.parse(init.body);
    if (url.endsWith('/create')) {
      const taskId = 'cloud-' + (creates.length + 1);
      creates.push(taskId);
      return Response.json({code: 0, data: {taskId}});
    }
    if (url.endsWith('/outputs')) return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true});
      polls.set(body.taskId, () => resolve(Response.json({code: 0, data: [
        {nodeId: '10', fileType: 'png', fileUrl: 'https://cdn.example/' + body.taskId, consumeCoins: 12},
      ]})));
    });
    assert.ok(url.endsWith('/cancel'));
    cancelled.push(body.taskId);
    return new Promise(resolve => { finishCancel = () => resolve(Response.json({code: 0})); });
  });
  api.saveDraw({engine: 'comfy', comfy: {url: RUNNINGHUB_URL, workflow}, queue: {gptConcurrency: 1, runninghubConcurrency: 2}});
  api.setKey('runninghub', 'fixture');
  const jobs = ['a', 'b', 'c'].map(key => api.generateImage({key, prompt: key, params: {seed: key.charCodeAt(0)}}));
  const rejected = assert.rejects(jobs[1], {cancelled: true});
  await nextTurn();
  assert.equal(polls.size, 2);
  assert.deepEqual(api.drawQueue().map(j => j.channel), Array(3).fill('runninghub'));
  api.cancelDraw('b');
  await nextTurn();
  assert.deepEqual(cancelled, ['cloud-2']);
  assert.equal(creates.length, 2);
  finishCancel();
  await rejected;
  await nextTurn();
  assert.equal(polls.size, 3);
  polls.get('cloud-3')();
  const third = await jobs[2];
  polls.get('cloud-1')();
  const first = await jobs[0];
  assert.equal(third.seed, 'c'.charCodeAt(0));
  assert.equal(third.params.runninghubTaskId, 'cloud-3');
  assert.equal(first.params.runninghubTaskId, 'cloud-1');
  assert.equal(photos.size, 2);
  assert.deepEqual(api.drawQueue(), []);
});

test('a queued story image skips the provider if the original picture block is gone', async () => {
  const calls = [];
  let finish, current = true;
  const {backend, api, photos} = fixture(async (url, init) => {
    calls.push(JSON.parse(init.body).prompt);
    return new Promise(resolve => { finish = () => resolve(Response.json({data: [{b64_json: btoa('first')}]})); });
  });
  api.saveDraw({engine: 'gpt', queue: {gptConcurrency: 1}});
  api.setKey('gpt', 'fixture');
  const first = api.generateImage({prompt: 'first', allowPaid: true});
  const stale = backend.generateImage({prompt: 'removed', allowPaid: true, valid: () => current});
  current = false;
  const cancelled = assert.rejects(stale, {cancelled: true});
  finish();
  await Promise.all([first, cancelled]);
  assert.equal(calls.length, 1);
  assert.equal(photos.size, 1);
});
