import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const readerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/reader');
const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.runInNewContext(readFileSync(path.join(readerDir, 'playback-utils.js'), 'utf8'), sandbox);
const playback = sandbox.PictureBookPlayback;

test('playback rate clamps to a child-friendly range and rounds to 0.05 steps', () => {
  assert.equal(playback.normalizeRate(0.2), 0.75);
  assert.equal(playback.normalizeRate(0.8), 0.8);
  assert.equal(playback.normalizeRate(0.9), 0.9);
  assert.equal(playback.normalizeRate(0.93), 0.95);
  assert.equal(playback.normalizeRate(1), 1);
  assert.equal(playback.normalizeRate(1.28), 1.25);
  assert.equal(playback.normalizeRate('fast'), 1);
});

test('bilingual reading queues English then Chinese for each page and skips absent audio', () => {
  const pages = [
    { index: 1, englishAudio: null, chineseAudio: null },
    { index: 2, englishAudio: 'en-2.mp3', chineseAudio: 'zh-2.mp3' },
    { index: 3, englishAudio: 'en-3.mp3', chineseAudio: null },
  ];
  const queue = playback.buildQueue(pages, 'bilingual');
  assert.equal(JSON.stringify(queue.map(({ pageIndex, language, audioPath }) => ({ pageIndex, language, audioPath }))), JSON.stringify([
    { pageIndex: 2, language: 'en', audioPath: 'en-2.mp3' },
    { pageIndex: 2, language: 'zh', audioPath: 'zh-2.mp3' },
    { pageIndex: 3, language: 'en', audioPath: 'en-3.mp3' },
  ]));
});

test('reading queue stops immediately when playback is cancelled or a clip fails', async () => {
  const queue = playback.buildQueue([
    { index: 1, englishAudio: 'en-1.mp3', chineseAudio: 'zh-1.mp3' },
  ], 'bilingual');
  const played = [];
  const complete = await playback.playQueue(queue, async (item) => {
    played.push(item.language);
    return item.language !== 'zh';
  });
  assert.equal(complete, false);
  assert.deepEqual(played, ['en', 'zh']);
});
