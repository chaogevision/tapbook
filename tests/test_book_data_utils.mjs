import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const readerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/reader');
const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.runInNewContext(readFileSync(path.join(readerDir, 'book-data-utils.js'), 'utf8'), sandbox);
const bookData = sandbox.PictureBookData;

const fixtureBook = { title: 'Local book', pages: [{ index: 1 }] };

test('loads embedded book data under file protocol without calling fetch', async () => {
  let fetchCalls = 0;
  const result = await bookData.loadBookData({
    embeddedText: JSON.stringify(fixtureBook),
    protocol: 'file:',
    fetcher: async () => { fetchCalls += 1; throw new Error('fetch must not run'); },
  });
  assert.equal(result.title, fixtureBook.title);
  assert.equal(fetchCalls, 0);
});

test('fetches book.json over HTTP when no embedded data is present', async () => {
  let requestedPath = '';
  const result = await bookData.loadBookData({
    embeddedText: '',
    protocol: 'http:',
    fetcher: async (url, options) => {
      requestedPath = `${url}:${options.cache}`;
      return { ok: true, json: async () => fixtureBook };
    },
  });
  assert.equal(result.title, fixtureBook.title);
  assert.equal(requestedPath, './book.json:no-store');
});

test('explains how to recover when an unpackaged reader is opened with file protocol', async () => {
  await assert.rejects(
    bookData.loadBookData({ embeddedText: '', protocol: 'file:', fetcher: async () => ({ ok: true, json: async () => fixtureBook }) }),
    /完整解压.*双击.*index\.html/,
  );
});

test('rejects malformed or empty embedded book data', async () => {
  await assert.rejects(bookData.loadBookData({ embeddedText: '{broken', protocol: 'file:' }), (error) => error.name === 'SyntaxError');
  await assert.rejects(bookData.loadBookData({ embeddedText: '{"pages":[]}', protocol: 'file:' }), /has no pages/);
});
