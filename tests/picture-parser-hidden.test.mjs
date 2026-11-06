import assert from 'node:assert/strict';
import test from 'node:test';
import {blockRanges, parsePictures, renderPictures} from '../core/draw.js';

const story = '<think_nya>规划时参考 <img>...</img> 格式。</think_nya>\n<game>\n<img>\n画幅：竖\n场景：sunset garden\n角色：Lin｜standing, green robe\n</img>\n<details><summary>插图</summary><img>rainy street|Yu</img></details>\n<img prompt="quiet library" characters="Mei">\n</game>';

test('visible story pictures retain existing photo hashes after a reasoning example is excluded', () => {
  const pictures = parsePictures(story);
  assert.deepEqual(pictures.map(({index, prompt}) => ({index, prompt})), [
    {index: 0, prompt: 'sunset garden'},
    {index: 1, prompt: 'rainy street'},
    {index: 2, prompt: 'quiet library'},
  ]);
  // Recorded from the pre-fix parser, whose original indices were 1, 2 and 3.
  assert.deepEqual(pictures.map(picture => picture.hash), ['l1kl5y', 'z1jck7', '5evhmk']);
  const rendered = renderPictures(story, 'test');
  assert.equal((rendered.match(/data-sttts-pic=/g) || []).length, 3);
  assert.ok(rendered.includes('<think_nya>规划时参考 <img>...</img> 格式。</think_nya>'));
  assert.ok(!rendered.includes('data-sttts-hash="1af55pf"'));
  for (const picture of pictures) assert.ok(rendered.includes('data-sttts-hash="' + picture.hash + '"'));
  const stored = Object.fromEntries(pictures.map(picture => [picture.hash, {url: '/images/' + picture.hash + '.png'}]));
  const passive = renderPictures(story, 'test', {passive: true, pictures: stored});
  for (const picture of pictures) assert.ok(passive.includes('/images/' + picture.hash + '.png'));
});

test('single-line and nested reasoning tags do not become pictures', () => {
  for (const name of ['think', 'thinking', 'think_nya', 'think-extra', 'REASONING', 'analysis']) {
    const source = '<' + name + '><img>example</img></' + name + '><game><img>real scene</img></game>';
    assert.deepEqual(parsePictures(source).map(picture => picture.prompt), ['real scene'], name);
  }
  const nested = '<think_nya><analysis><img>inner example</img></analysis><think><img>another example</img></think></think_nya><details><img>real scene</img></details>';
  assert.deepEqual(parsePictures(nested).map(picture => picture.prompt), ['real scene']);
});

test('an unclosed reasoning section stays hidden through the remaining reply', () => {
  const visible = '<img>real scene</img>';
  for (const unfinished of [
    '<think_nya><img>example</img>',
    '<reasoning>\n<img>example</img>\n',
    '<analysis><think><img>example</img></think>',
    '<game><think_nya><img>example</img></game><img>still hidden</img>',
  ]) assert.deepEqual(parsePictures(visible + unfinished).map(picture => picture.prompt), ['real scene']);
});

test('code fences and comments exclude examples in single-line, multiline and unfinished forms', () => {
  const visible = '<img>real scene</img>';
  for (const example of [
    '```<img>example</img>```',
    '```html\n<img>example</img>\n```',
    '````html\n```\n<img>example</img>\n````',
    '~~~<img>example</img>~~~',
    '<!-- <img>example</img> -->',
    '<!--\n<img>example</img>\n-->',
  ]) assert.deepEqual(parsePictures(example + visible).map(picture => picture.prompt), ['real scene']);
  for (const example of ['```<img>example</img>', '~~~\n<img>example</img>', '<!--<img>example</img>']) {
    assert.deepEqual(parsePictures(visible + example).map(picture => picture.prompt), ['real scene']);
  }
});

test('reasoning tag text inside a code example cannot hide later story pictures', () => {
  assert.deepEqual(parsePictures('```<think_nya><img>example</img>```<img>real scene</img>').map(picture => picture.prompt), ['real scene']);
  for (const example of [
    'Here is `<think_nya>`',
    'Here is ``a `<think_nya>` example``',
    '`<img>example</img>`',
    '<code><think_nya><img>example</img></code>',
    '<pre><analysis><img>example</img></pre>',
  ]) assert.deepEqual(parsePictures(example + '\n<game><img>real scene</img></game>').map(picture => picture.prompt), ['real scene']);
});

test('planning block ranges keep their default multiline and closed-tag behavior', () => {
  assert.deepEqual(blockRanges('<think>text</think><!-- text -->```text```'), []);
  assert.deepEqual(blockRanges('<think>\ntext'), []);
  assert.deepEqual(blockRanges('<details>\ntext\n</details>').map(([, , name]) => name), ['details']);
});
