import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultDraw, normalizeDraw} from '../core/draw.js';
import {installDrawSettings} from '../core/backend-draw.js';

test('existing queue settings receive both channel limits without losing NovelAI settings', () => {
  const cloud = {enabled: true, kind: 'room', url: 'https://example.test', room: 'draw-room'};
  assert.deepEqual(normalizeDraw({queue: {gap: 7, retries: 1, cloud}}).queue, {
    gap: 7, retries: 1, cloud, gptConcurrency: 2, runninghubConcurrency: 2,
  });
});

test('imported concurrency limits are independent integers from 1 to 4', () => {
  const queue = (gptConcurrency, runninghubConcurrency) => normalizeDraw({queue: {gptConcurrency, runninghubConcurrency}}).queue;
  const bounds = queue(-5, 9), rounded = queue(2.8, 'invalid');
  assert.equal(bounds.gptConcurrency, 1);
  assert.equal(bounds.runninghubConcurrency, 4);
  assert.equal(rounded.gptConcurrency, 3);
  assert.equal(rounded.runninghubConcurrency, 2);
});

test('changing one channel in drawing settings preserves the other limit', () => {
  class Backend {
    settings = {draw: defaultDraw()};
    getState() { return structuredClone(this.settings); }
    save(next) { this.settings = next; }
  }
  installDrawSettings(Backend);
  const backend = new Backend();
  backend.saveDraw({queue: {gptConcurrency: 1}});
  backend.saveDraw({queue: {runninghubConcurrency: 4}});
  const {queue} = normalizeDraw(backend.getState().draw);
  assert.equal(queue.gptConcurrency, 1);
  assert.equal(queue.runninghubConcurrency, 4);
});
