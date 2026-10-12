'use strict';

(function attachPictureBookData(root) {
  function validateBook(book) {
    if (!Array.isArray(book?.pages) || !book.pages.length) throw new Error('book.json has no pages');
    return book;
  }

  function parseEmbeddedBookData(embeddedText) {
    const source = String(embeddedText || '').trim();
    return source ? validateBook(JSON.parse(source)) : null;
  }

  async function loadBookData({ embeddedText = '', protocol = '', fetcher = root.fetch?.bind(root) } = {}) {
    const embedded = parseEmbeddedBookData(embeddedText);
    if (embedded) return embedded;

    if (protocol === 'file:') {
      throw new Error('这个页面没有内嵌绘本数据。请完整解压压缩包后，双击 index.html；如仍失败，请使用新版 TapBook 重新打包。');
    }
    if (typeof fetcher !== 'function') throw new Error('当前环境无法读取 book.json');

    const response = await fetcher('./book.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`book.json returned ${response.status}`);
    return validateBook(await response.json());
  }

  root.PictureBookData = Object.freeze({ parseEmbeddedBookData, loadBookData });
}(globalThis));
