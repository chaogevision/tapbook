'use strict';

(function attachPictureBookPlayback(root) {
  function normalizeRate(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 1;
    const clamped = Math.max(0.75, Math.min(1.25, parsed));
    return Math.round(clamped * 20) / 20;
  }

  function buildQueue(pages, mode) {
    const languages = mode === 'bilingual' ? ['en', 'zh'] : [mode === 'zh' ? 'zh' : 'en'];
    const queue = [];
    for (const [offset, page] of (Array.isArray(pages) ? pages : []).entries()) {
      for (const language of languages) {
        const audioPath = language === 'zh' ? page.chineseAudio : page.englishAudio;
        if (!audioPath) continue;
        queue.push({ pageIndex: page.index ?? offset, language, audioPath });
      }
    }
    return queue;
  }

  async function playQueue(queue, playClip) {
    for (const item of queue) {
      if (!await playClip(item)) return false;
    }
    return true;
  }

  root.PictureBookPlayback = Object.freeze({ normalizeRate, buildQueue, playQueue });
}(globalThis));
