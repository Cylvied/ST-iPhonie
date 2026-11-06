import assert from 'node:assert/strict';
import test from 'node:test';
import {DrawQueue} from '../core/draw-queue.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function hold(queue, channel, key) {
  const gate = deferred();
  const job = queue.add({key, channel, task: () => gate.promise});
  return {...gate, job};
}

const active = (queue, channel) => queue.list().filter(j => j.channel === channel && j.state === 'running').map(j => j.key);

test('each provider starts two jobs, then starts the oldest waiting job when either slot is free', async () => {
  const forbidden = () => assert.fail('Parallel jobs must not use NovelAI locks, leases or spacing');
  const queue = new DrawQueue({locks: {request: forbidden}, remote: forbidden, storage: {get: forbidden, set: forbidden}});
  const gpt = ['a', 'b', 'c', 'd'].map(key => hold(queue, 'gpt', key));
  const rh = ['e', 'f', 'g'].map(key => hold(queue, 'runninghub', key));
  assert.deepEqual(active(queue, 'gpt'), ['a', 'b']);
  assert.deepEqual(active(queue, 'runninghub'), ['e', 'f']);
  assert.equal(queue.get('g').position, 2);
  gpt[1].resolve('b'); await gpt[1].job;
  assert.deepEqual(active(queue, 'gpt'), ['a', 'c']);
  assert.equal(queue.get('d').state, 'waiting');
  rh[1].resolve('f'); await rh[1].job;
  assert.deepEqual(active(queue, 'runninghub'), ['e', 'g']);
  for (const h of [...gpt, ...rh]) h.resolve();
  await Promise.all([...gpt, ...rh].map(h => h.job));
  assert.deepEqual(queue.list(), []);
  assert.equal(queue.pending, false);
});

test('cancelling a running job retains its slot during cleanup, while cancelling a waiting job removes it immediately', async () => {
  const queue = new DrawQueue({concurrency: () => 1});
  const cleanup = deferred(), stopped = deferred();
  const run = queue.add({key: 'active', channel: 'runninghub', task: async signal => {
    signal.addEventListener('abort', stopped.resolve, {once: true});
    await cleanup.promise;
    signal.throwIfAborted();
  }});
  const waiting = hold(queue, 'runninghub', 'next');
  const dropped = queue.add({key: 'drop', channel: 'runninghub', task: () => assert.fail('Cancelled waiting job ran')});
  const isCancelled = error => error.cancelled === true;
  assert.equal(queue.cancel('drop'), true);
  await assert.rejects(dropped, isCancelled);
  assert.equal(queue.get('drop'), null);
  queue.cancel('active');
  await stopped.promise;
  assert.equal(queue.get('next').state, 'waiting');
  assert.equal(queue.add({key: 'active', task: () => assert.fail('Duplicate key ran')}), run);
  assert.equal(queue.pending, true);
  cleanup.resolve(); await assert.rejects(run, isCancelled);
  assert.equal(queue.get('next').state, 'running');
  waiting.resolve(); await waiting.job;
  assert.equal(queue.pending, false);
});

test('changes to a limit admit more jobs immediately and let existing requests finish when it falls', async () => {
  let limit = 0;
  const queue = new DrawQueue({concurrency: () => limit});
  const jobs = Array.from({length: 6}, (_, i) => hold(queue, 'gpt', String(i)));
  assert.deepEqual(active(queue, 'gpt'), ['0']);
  limit = 99; queue.pump();
  assert.deepEqual(active(queue, 'gpt'), ['0', '1', '2', '3']);
  limit = 1; queue.pump();
  jobs[1].resolve(); await jobs[1].job;
  assert.deepEqual(active(queue, 'gpt'), ['0', '2', '3']);
  assert.equal(queue.get('4').state, 'waiting');
  for (const h of jobs) h.resolve();
  await Promise.all(jobs.map(h => h.job));
});

test('cancel all aborts every active request and discards waiting jobs in every lane', async () => {
  const queue = new DrawQueue({concurrency: () => 2});
  const started = [];
  const submit = (channel, key) => queue.add({channel, key, task: signal => new Promise((_, reject) => {
    started.push(key);
    signal.addEventListener('abort', () => reject(signal.reason), {once: true});
  })});
  const jobs = ['gpt', 'runninghub'].flatMap(channel => [1, 2, 3].map(i => submit(channel, channel + i)));
  queue.cancelAll();
  assert.deepEqual(started, ['gpt1', 'gpt2', 'runninghub1', 'runninghub2']);
  const results = await Promise.allSettled(jobs);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.cancelled));
  assert.equal(queue.pending, false);
});

test('only an explicit GPT rate limit retries, never repeat an ambiguous or failed RunningHub submission', async () => {
  const waits = [];
  const queue = new DrawQueue({retries: () => 1, backoff: () => 100, wait: async ms => { waits.push(ms); }});
  const limited = Object.assign(Error('limit'), {status: 429});
  let gpt = 0, rh = 0, unknown = 0;
  const success = queue.add({channel: 'gpt', task: () => { if (++gpt === 1) throw limited; return 'ok'; }});
  const failed = queue.add({channel: 'runninghub', task: () => { rh++; throw limited; }});
  const unclear = queue.add({channel: 'gpt', task: () => { unknown++; throw Error('network'); }});
  await assert.rejects(failed, error => error === limited);
  await assert.rejects(unclear, /network/);
  assert.equal(await success, 'ok');
  assert.deepEqual([gpt, rh, unknown], [2, 1, 1]);
  assert.deepEqual(waits, [100]);
});

test('serial jobs keep the Web Lock, cloud lease and spacing and release the slot after lock failure', async () => {
  let now = 100, last = 95, lockCalls = 0, turns = 0;
  const gaps = [], releases = [];
  const queue = new DrawQueue({
    locks: {request: async (name, options, run) => {
      assert.equal(name, 'st-iphonie-novelai'); assert.ok(options.signal instanceof AbortSignal);
      if (++lockCalls === 1) throw Error('lock unavailable');
      return run();
    }},
    gap: () => 10, now: () => now, storage: {get: () => last, set: t => { last = t; }},
    wait: async ms => { gaps.push(ms); now += ms; },
    remote: () => ({acquire: async () => { turns++; return {release: outcome => releases.push(outcome)}; }})
  });
  const failed = queue.add({key: 'failed', task: () => assert.fail('Failed lock ran its task')});
  const started = deferred(), done = deferred();
  const first = queue.add({key: 'first', task: async () => { started.resolve(); await done.promise; }});
  const next = queue.add({key: 'next', task: () => 'finished'});
  await assert.rejects(failed, /lock unavailable/);
  await started.promise;
  assert.equal(queue.get('next').state, 'waiting');
  done.resolve(); await first;
  assert.equal(await next, 'finished');
  assert.deepEqual(gaps, [5, 10]);
  assert.deepEqual(releases, ['done', 'done']);
  assert.equal(turns, 2);
  assert.equal(queue.pending, false);
});
