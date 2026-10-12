'use strict';

const $ = (id) => document.getElementById(id);
const THEMES = new Set(['winter', 'vehicles', 'construction', 'ocean', 'forest', 'farm', 'space', 'storybook']);
const BookData = globalThis.PictureBookData;
const THEME_LABELS = Object.freeze({
  default: '柔彩舞台', storybook: '故事花园', winter: '冬日雪原', vehicles: '交通小镇',
  construction: '工程工地', ocean: '海底世界', forest: '森林漫步', farm: '田园农场', space: '星际探险', book: '本书专属背景',
});
const THEME_ICON_MODES = new Set(['default', 'storybook', 'winter', 'vehicles', 'construction', 'ocean', 'forest', 'farm', 'space']);
const Playback = globalThis.PictureBookPlayback;
const Hotspots = globalThis.PictureBookHotspots;
const PLAYBACK_RATE_KEY = 'picturebook-playback-rate:v1';
const STORY_KINDS = new Set(['story', 'illustration']);
const state = {
  book: null,
  pageIndex: 0,
  activeAudio: null,
  activeAudioKind: null,
  playbackId: 0,
  activeWord: null,
  activeSentenceIndex: 0,
  resizeObserver: null,
  touchStart: null,
  facingPages: false,
  themeMode: 'default',
  autoTheme: 'storybook',
  hasBookTheme: false,
  playbackRate: 1,
  activeAudioCancel: null,
};

const slots = [
  { frame: $('page-slot-left'), image: $('page-image-left'), hotspots: $('hotspot-layer-left') },
  { frame: $('page-slot-right'), image: $('page-image-right'), hotspots: $('hotspot-layer-right') },
];

function reportFatal(message) {
  $('reader-shell').hidden = true;
  $('fatal-message').textContent = message;
  $('fatal-error').hidden = false;
}

function currentPage() {
  return state.book?.pages[state.pageIndex] || null;
}

function stopAudio() {
  state.playbackId += 1;
  const audio = state.activeAudio;
  const cancel = state.activeAudioCancel;
  state.activeAudioCancel = null;
  if (audio) {
    audio.onended = null;
    audio.ontimeupdate = null;
    audio.onerror = null;
    audio.onloadedmetadata = null;
    audio.pause();
    try { audio.currentTime = 0; } catch { /* metadata may not have loaded */ }
    state.activeAudio = null;
  }
  cancel?.();
  state.activeAudioKind = null;
  state.activeWord = null;
  document.querySelectorAll('.is-speaking').forEach((node) => node.classList.remove('is-speaking'));
  $('play-sentence').textContent = '▶';
  $('play-sentence').setAttribute('aria-label', '朗读当前句');
  $('stop-playback').disabled = true;
  $('progress-fill').style.width = '0%';
  $('audio-time').textContent = '—';
  $('playback-status').textContent = '';
}

function setPlaybackStatus(message) {
  $('playback-status').textContent = message;
  $('stop-playback').disabled = !state.activeAudio;
}

function normalizeWord(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[’]/g, "'")
    .replace(/^["'“”‘’.,!?;:()[\]{}<>—–…]+|["'“”‘’.,!?;:()[\]{}<>—–…]+$/g, '')
    .toLocaleLowerCase();
}

function isSentenceEnd(text) {
  return /[.!?]["'”’)]*$/.test(text || '');
}

function pageSentences(page) {
  const words = Array.isArray(page.words) ? page.words : [];
  if (!words.length) return [];
  if (Array.isArray(page.sentences) && page.sentences.length) {
    return page.sentences.map((sentence, sentenceIndex) => ({
      wordStart: sentence.wordStart,
      wordEnd: sentence.wordEnd,
      translationZh: sentence.translationZh,
      sentenceIndex,
      words: words.slice(sentence.wordStart, sentence.wordEnd).map((word, offset) => ({ word, index: sentence.wordStart + offset })),
    }));
  }
  const groups = [];
  let start = 0;
  words.forEach((word, index) => {
    if (!isSentenceEnd(word.text)) return;
    groups.push({ wordStart: start, wordEnd: index + 1, translationZh: sentenceFallback(page, groups.length), sentenceIndex: groups.length, words: words.slice(start, index + 1).map((item, offset) => ({ word: item, index: start + offset })) });
    start = index + 1;
  });
  if (start < words.length) groups.push({ wordStart: start, wordEnd: words.length, translationZh: sentenceFallback(page, groups.length), sentenceIndex: groups.length, words: words.slice(start).map((word, offset) => ({ word, index: start + offset })) });
  return groups;
}

function sentenceFallback(page, sentenceIndex) {
  return sentenceIndex === 0 ? (page.zhText || '') : '';
}

function sentenceTiming(page, group) {
  const timings = Array.isArray(page.wordTimings) ? page.wordTimings : [];
  const words = page.words || [];
  if (!timings.length || group.wordStart == null || group.wordEnd == null) return null;
  let first = null;
  let last = null;
  let cursor = 0;
  for (let wordIndex = group.wordStart; wordIndex < group.wordEnd; wordIndex += 1) {
    const expected = normalizeWord(words[wordIndex]?.text);
    let match = -1;
    for (let timingIndex = cursor; timingIndex < timings.length; timingIndex += 1) {
      if (normalizeWord(timings[timingIndex].text) === expected) { match = timingIndex; break; }
    }
    if (match < 0) return null;
    first ??= timings[match];
    last = timings[match];
    cursor = match + 1;
  }
  const start = Number(first?.start);
  const end = Number(last?.start) + Number(last?.duration);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

function showMeaning(word) {
  $('meaning-word').textContent = word.text;
  $('meaning-zh').textContent = word.meaningZh;
  $('word-lookup').hidden = false;
  $('word-prompt').hidden = true;
}

function themePreferenceKey(book) {
  return `picturebook-theme-mode:v1:${book.title}`;
}

function setThemeMode(mode, persist = true) {
  const book = state.book;
  if (!book) return;
  const resolvedMode = mode === 'book' && state.hasBookTheme
    ? 'book'
    : (mode === 'default' || THEMES.has(mode) ? mode : state.autoTheme);
  const theme = book.readerTheme || {};
  state.themeMode = resolvedMode;
  const themeKey = resolvedMode === 'book' ? (THEMES.has(theme.preset) ? theme.preset : 'storybook') : resolvedMode;
  const useBookTheme = resolvedMode === 'book';
  const landscape = useBookTheme
    ? theme.backgroundImage
    : `themes/backgrounds/${resolvedMode}-landscape.webp`;
  const portrait = useBookTheme
    ? (theme.backgroundImagePortrait || theme.backgroundImage)
    : `themes/backgrounds/${resolvedMode}-portrait.webp`;
  const themeArt = $('theme-art');
  const portraitArt = $('theme-art-portrait');
  if (portrait) portraitArt.srcset = portrait;
  else portraitArt.removeAttribute('srcset');
  themeArt.onerror = () => {
    themeArt.onerror = null;
    if (state.themeMode === 'book' || state.themeMode === 'default') {
      setThemeMode(state.autoTheme, true);
      return;
    }
    portraitArt.srcset = 'themes/backgrounds/storybook-portrait.webp';
    themeArt.src = 'themes/backgrounds/storybook-landscape.webp';
    themeArt.onerror = () => { themeArt.onerror = null; };
  };
  $('reader-shell').dataset.theme = themeKey;
  themeArt.src = landscape;
  $('book-theme-choice').hidden = !state.hasBookTheme;
  $('theme-current-name').textContent = THEME_LABELS[resolvedMode] || '阅读场景';
  const themeName = THEME_LABELS[resolvedMode] || '阅读场景';
  $('theme-button').setAttribute('aria-label', `选择阅读场景，当前为${themeName}`);
  $('theme-button').title = `当前：${themeName}`;
  $('theme-current-icon').src = `themes/icons/${THEME_ICON_MODES.has(resolvedMode) ? resolvedMode : 'book'}.svg`;
  document.querySelectorAll('.theme-choice').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.themeMode === resolvedMode));
  });
  $('theme-menu-note').textContent = useBookTheme
    ? '正在使用本书专属背景；也可以切换到任一内置场景。'
    : `当前场景：${THEME_LABELS[resolvedMode] || '故事花园'}。默认按整本绘本主题预选。`;
  if (persist) {
    try { localStorage.setItem(themePreferenceKey(book), state.themeMode); } catch { /* storage can be disabled */ }
  }
}

function applyTheme(book) {
  const requested = book.readerTheme?.preset;
  const preset = THEMES.has(requested) ? requested : 'storybook';
  state.autoTheme = preset;
  state.hasBookTheme = Boolean(book.readerTheme?.backgroundImage);
  let preferredMode = preset;
  try {
    const saved = localStorage.getItem(themePreferenceKey(book));
    if (saved === 'book' && state.hasBookTheme) preferredMode = 'book';
    else if (saved === 'default' || THEMES.has(saved)) preferredMode = saved;
  } catch { /* choose from the PDF analysis */ }
  setThemeMode(preferredMode, false);
}

function savedPlaybackRate() {
  try { return Playback.normalizeRate(localStorage.getItem(PLAYBACK_RATE_KEY) || 1); }
  catch { return 1; }
}

function setPlaybackRate(value, persist = true) {
  state.playbackRate = Playback.normalizeRate(value);
  $('playback-rate').value = String(state.playbackRate);
  if (state.activeAudio) state.activeAudio.playbackRate = state.playbackRate;
  if (persist) {
    try { localStorage.setItem(PLAYBACK_RATE_KEY, String(state.playbackRate)); } catch { /* audio still works without storage */ }
  }
}

function firstStoryIndex() {
  return state.book.pages.findIndex((page) => STORY_KINDS.has(page.kind));
}

function layoutMode() {
  const mode = state.book?.presentation?.pageMode || 'single';
  if (mode === 'source-spread') return mode;
  if (mode !== 'facing-pages') return 'single';
  const wideLandscape = window.matchMedia('(min-width: 921px) and (orientation: landscape)').matches;
  return wideLandscape ? 'facing-pages' : 'single';
}

function pagePair(pageIndex) {
  const pages = state.book.pages;
  const start = firstStoryIndex();
  if (start < 0 || pageIndex < start || !STORY_KINDS.has(pages[pageIndex]?.kind)) return [pages[pageIndex]].filter(Boolean);
  const base = start + Math.floor((pageIndex - start) / 2) * 2;
  const left = pages[base];
  const right = pages[base + 1];
  if (!right || !STORY_KINDS.has(right.kind)) return [left].filter(Boolean);
  return [left, right];
}

function visiblePages() {
  const mode = layoutMode();
  state.facingPages = mode === 'facing-pages';
  if (mode === 'source-spread') return [{ page: currentPage(), slot: 0, sourceSpread: true }].filter((item) => item.page);
  const page = currentPage();
  if (state.facingPages && STORY_KINDS.has(page?.kind)) {
    const pair = pagePair(state.pageIndex);
    return pair.map((item, index) => ({ page: item, slot: index, sourceSpread: false }));
  }
  return page ? [{ page, slot: 0, sourceSpread: false }] : [];
}

function clearSlot(slot) {
  slot.frame.hidden = true;
  slot.frame.classList.remove('is-active-page');
  slot.image.removeAttribute('src');
  slot.image.alt = '';
  slot.image.dataset.pageIndex = '';
  slot.hotspots.replaceChildren();
}

function addHotspots(page, layer) {
  layer.replaceChildren();
  for (const [index, word] of (page.words || []).entries()) {
    if (!word.box) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'word-hotspot';
    button.style.left = `${word.box.x * 100}%`;
    button.style.top = `${word.box.y * 100}%`;
    button.style.width = `${word.box.w * 100}%`;
    button.style.height = `${word.box.h * 100}%`;
    button.dataset.boxX = String(word.box.x);
    button.dataset.boxY = String(word.box.y);
    button.dataset.boxWidth = String(word.box.w);
    button.dataset.boxHeight = String(word.box.h);
    button.setAttribute('aria-label', `${word.text}，${word.meaningZh}，点按朗读`);
    button.title = `${word.text} · ${word.meaningZh}`;
    button.dataset.wordIndex = String(index);
    button.dataset.pageIndex = String(page.index);
    const highlight = document.createElement('span');
    highlight.className = 'word-hotspot-highlight';
    highlight.setAttribute('aria-hidden', 'true');
    button.append(highlight);
    layer.append(button);
  }
}

function updateHotspotTargets(slot) {
  const frameWidth = slot.frame.clientWidth;
  const frameHeight = slot.frame.clientHeight;
  if (!frameWidth || !frameHeight) return;
  for (const button of slot.hotspots.querySelectorAll('.word-hotspot')) {
    const box = {
      x: Number(button.dataset.boxX),
      y: Number(button.dataset.boxY),
      w: Number(button.dataset.boxWidth),
      h: Number(button.dataset.boxHeight),
    };
    const target = Hotspots.targetRect(box, frameWidth, frameHeight);
    if (!target) continue;
    button.style.left = `${target.left}px`;
    button.style.top = `${target.top}px`;
    button.style.width = `${target.width}px`;
    button.style.height = `${target.height}px`;
    const highlight = button.querySelector('.word-hotspot-highlight');
    highlight.style.left = `${target.wordLeft}px`;
    highlight.style.top = `${target.wordTop}px`;
    highlight.style.width = `${target.wordWidth}px`;
    highlight.style.height = `${target.wordHeight}px`;
  }
}

function bindHotspotLayer(layer) {
  layer.addEventListener('click', (event) => {
    const clicked = event.target.closest('.word-hotspot');
    if (!clicked || !layer.contains(clicked)) return;

    let selected = clicked;
    if (event.detail !== 0 && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      const candidates = [...layer.querySelectorAll('.word-hotspot')].map((button) => {
        const targetRect = button.getBoundingClientRect();
        const wordRect = button.querySelector('.word-hotspot-highlight').getBoundingClientRect();
        return {
          button,
          hitRect: { left: targetRect.left, top: targetRect.top, right: targetRect.right, bottom: targetRect.bottom },
          centerX: wordRect.left + wordRect.width / 2,
          centerY: wordRect.top + wordRect.height / 2,
        };
      });
      selected = Hotspots.nearestAtPoint(candidates, event.clientX, event.clientY)?.button || clicked;
      if (selected !== clicked) selected.focus({ preventScroll: true });
    }

    const pageIndex = Number(selected.dataset.pageIndex);
    const wordIndex = Number(selected.dataset.wordIndex);
    const page = state.book?.pages.find((candidate) => candidate.index === pageIndex);
    const word = page?.words[wordIndex];
    if (word) playWord(word, wordIndex, page);
  });
}

function renderSlots(pages) {
  slots.forEach(clearSlot);
  const spread = $('book-spread');
  spread.classList.toggle('is-single', pages.length === 1 && !pages[0]?.sourceSpread);
  spread.classList.toggle('is-source-spread', pages.some((item) => item.sourceSpread));
  $('book-gutter').hidden = pages.length < 2;
  for (const item of pages) {
    const slot = slots[item.slot];
    const page = item.page;
    slot.frame.hidden = false;
    slot.image.onload = updateImageFit;
    slot.image.onerror = () => setPlaybackStatus('这一页的原图暂时无法载入。');
    if (slot.image.dataset.pageIndex !== String(page.index)) {
      slot.image.src = page.image;
      slot.image.dataset.pageIndex = String(page.index);
    }
    slot.image.alt = page.alt || `第 ${page.index} 页原书页面`;
    slot.frame.setAttribute('aria-label', `第 ${page.index} 页`);
    slot.frame.classList.toggle('is-active-page', page.index === currentPage().index);
    addHotspots(page, slot.hotspots);
  }
  $('book-spread').classList.toggle('has-right-page', pages.length === 2);
  requestAnimationFrame(updateImageFit);
}

function updateImageFit() {
  const activeSlots = slots.filter((slot) => !slot.frame.hidden && slot.image.naturalWidth && slot.image.naturalHeight);
  if (!activeSlots.length) return;
  const bounds = $('book-stage').getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const isPair = activeSlots.length > 1;
  const gutterWidth = isPair ? Math.min(20, Math.max(12, bounds.width * 0.014)) : 0;
  const totalWidth = activeSlots.reduce((sum, slot) => sum + slot.image.naturalWidth, 0);
  const maxHeight = Math.max(...activeSlots.map((slot) => slot.image.naturalHeight));
  const scale = Math.min((bounds.width - gutterWidth) / totalWidth, bounds.height / maxHeight);
  activeSlots.forEach((slot) => {
    slot.frame.style.width = `${Math.max(1, Math.floor(slot.image.naturalWidth * scale))}px`;
    slot.frame.style.height = `${Math.max(1, Math.floor(slot.image.naturalHeight * scale))}px`;
    updateHotspotTargets(slot);
  });
  $('book-gutter').style.width = `${gutterWidth}px`;
}

function renderActiveSentence() {
  const page = currentPage();
  const groups = pageSentences(page);
  state.activeSentenceIndex = Math.max(0, Math.min(state.activeSentenceIndex, groups.length - 1));
  const group = groups[state.activeSentenceIndex];
  const english = $('active-english');
  english.replaceChildren();
  if (group) {
    group.words.forEach(({ word, index }, offset) => {
      if (offset) english.append(document.createTextNode(' '));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dock-word';
      button.textContent = word.text;
      button.dataset.wordIndex = String(index);
      button.dataset.pageIndex = String(page.index);
      button.setAttribute('aria-label', `${word.text}，${word.meaningZh}，点按朗读`);
      button.addEventListener('click', () => playWord(word, index, page));
      english.append(button);
    });
    $('active-chinese').textContent = group.translationZh || page.zhText || '';
  } else {
    english.textContent = page.enText || '';
    $('active-chinese').textContent = page.zhText || '和孩子一起翻一翻这本书';
  }
  $('previous-sentence').disabled = !groups.length || state.activeSentenceIndex === 0;
  $('next-sentence').disabled = !groups.length || state.activeSentenceIndex >= groups.length - 1;
  $('play-sentence').disabled = !group || !page.englishAudio;
  $('read-page-en').disabled = !page.englishAudio;
  $('read-page-zh').disabled = !page.chineseAudio;
  $('read-page-bilingual').disabled = !page.englishAudio && !page.chineseAudio;
}

function updateProgressLabels(pages) {
  const start = pages.length > 1 ? pages[0].page.index : currentPage().index;
  const end = pages.length > 1 ? pages[pages.length - 1].page.index : start;
  $('progress-text').textContent = start === end ? `${start} / ${state.book.pages.length}` : `${start}–${end} / ${state.book.pages.length}`;
  $('page-status').textContent = start === end ? `第 ${start} 页 · 共 ${state.book.pages.length} 页` : `第 ${start}–${end} 页 · 共 ${state.book.pages.length} 页`;
  $('previous-page').disabled = state.pageIndex === 0;
  $('next-page').disabled = state.pageIndex >= state.book.pages.length - 1;
}

function renderPage() {
  const page = currentPage();
  if (!page) return;
  $('book-title').textContent = state.book.title;
  const pages = visiblePages();
  renderSlots(pages);
  updateProgressLabels(pages);
  $('read-book').disabled = !state.book.pages.some((item) => item.englishAudio || item.chineseAudio);
  $('word-lookup').hidden = true;
  $('word-prompt').hidden = false;
  renderActiveSentence();
  $('playback-status').textContent = '';
}

function navTarget(direction) {
  const page = currentPage();
  if (layoutMode() === 'facing-pages' && STORY_KINDS.has(page?.kind)) {
    const start = firstStoryIndex();
    const base = start + Math.floor((state.pageIndex - start) / 2) * 2;
    if (direction > 0) return Math.min(state.book.pages.length - 1, base + 2);
    if (base > start) return base - 2;
    return Math.max(0, start - 1);
  }
  return Math.max(0, Math.min(state.book.pages.length - 1, state.pageIndex + direction));
}

function goToPage(index) {
  if (!state.book || index < 0 || index >= state.book.pages.length || index === state.pageIndex) return;
  stopAudio();
  state.pageIndex = index;
  state.activeSentenceIndex = 0;
  renderPage();
  const spread = $('book-spread');
  spread.classList.remove('turn-next', 'turn-prev');
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    spread.classList.add(index > Number(spread.dataset.previousIndex || 0) ? 'turn-next' : 'turn-prev');
    window.setTimeout(() => spread.classList.remove('turn-next', 'turn-prev'), 380);
  }
  spread.dataset.previousIndex = String(index);
}

function makeAudio(path) {
  if (!path || typeof path !== 'string') throw new Error('音频路径为空');
  const audio = new Audio(new URL(path, document.baseURI).href);
  audio.preload = 'auto';
  audio.setAttribute('playsinline', '');
  audio.playbackRate = state.playbackRate;
  if ('preservesPitch' in audio) audio.preservesPitch = true;
  if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = true;
  if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;
  return audio;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function wordIndexAtTime(page, time) {
  const timings = page.wordTimings || [];
  const words = page.words || [];
  for (let timingIndex = 0; timingIndex < timings.length; timingIndex += 1) {
    const timing = timings[timingIndex];
    if (time < Number(timing.start) || time >= Number(timing.start) + Number(timing.duration)) continue;
    const token = normalizeWord(timing.text);
    if (normalizeWord(words[timingIndex]?.text) === token) return timingIndex;
    return words.findIndex((word) => normalizeWord(word.text) === token);
  }
  return -1;
}

function setSpeakingWord(page, wordIndex) {
  document.querySelectorAll('.word-hotspot.is-speaking, .dock-word.is-speaking, .dock-word.is-current').forEach((node) => node.classList.remove('is-speaking', 'is-current'));
  if (wordIndex < 0) return;
  const pageIndex = String(page.index);
  document.querySelectorAll(`[data-page-index="${pageIndex}"][data-word-index="${wordIndex}"]`).forEach((node) => node.classList.add('is-speaking'));
  const groups = pageSentences(page);
  const sentenceIndex = groups.findIndex((group) => wordIndex >= group.wordStart && wordIndex < group.wordEnd);
  if (sentenceIndex >= 0 && page.index === currentPage()?.index && sentenceIndex !== state.activeSentenceIndex) {
    state.activeSentenceIndex = sentenceIndex;
    renderActiveSentence();
  }
  const activeSentence = $('active-english').querySelector(`[data-page-index="${pageIndex}"][data-word-index="${wordIndex}"]`);
  activeSentence?.classList.add('is-current');
}

async function playClip(path, label, options = {}, playbackId = null) {
  if (!path) {
    setPlaybackStatus('本页没有生成这段语音。');
    return false;
  }
  let audio;
  try { audio = makeAudio(path); } catch { setPlaybackStatus('音频路径无效，无法播放。'); return false; }
  state.activeAudio = audio;
  state.activeAudioKind = options.kind || 'narration';
  $('stop-playback').disabled = false;
  $('play-sentence').textContent = 'Ⅱ';
  $('play-sentence').setAttribute('aria-label', '暂停朗读');
  setPlaybackStatus(label);
  return new Promise((resolve) => {
    let settled = false;
    let cancelPlayback = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      audio.onended = null;
      audio.ontimeupdate = null;
      audio.onerror = null;
      audio.onloadedmetadata = null;
      if (state.activeAudio === audio) {
        state.activeAudio = null;
        state.activeAudioKind = null;
      }
      if (state.activeAudioCancel === cancelPlayback) state.activeAudioCancel = null;
      if (playbackId === null || playbackId === state.playbackId) {
        $('stop-playback').disabled = true;
        $('play-sentence').textContent = '▶';
        $('play-sentence').setAttribute('aria-label', '朗读当前句');
        if (!ok) setPlaybackStatus('这段音频无法播放，请检查本地音频文件。');
      }
      resolve(ok);
    };
    cancelPlayback = () => finish(false);
    state.activeAudioCancel = cancelPlayback;
    const begin = () => {
      if (options.range) audio.currentTime = Math.max(0, options.range.start);
      audio.ontimeupdate = () => {
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        if (duration > 0) {
          $('progress-fill').style.width = `${Math.max(0, Math.min(100, audio.currentTime / duration * 100))}%`;
          $('audio-time').textContent = `${formatTime(audio.currentTime)} / ${formatTime(duration)}`;
        }
        if (options.page && options.language === 'en') {
          const wordIndex = wordIndexAtTime(options.page, audio.currentTime);
          if (wordIndex !== state.activeWord) {
            state.activeWord = wordIndex;
            setSpeakingWord(options.page, wordIndex);
          }
        }
        if (options.range && audio.currentTime >= options.range.end) {
          audio.pause();
          finish(true);
        }
      };
      audio.play().catch(() => finish(false));
    };
    audio.onerror = () => finish(false);
    audio.onended = () => finish(true);
    if (options.range) audio.onloadedmetadata = begin;
    else begin();
  });
}

async function playWord(word, wordIndex, page) {
  stopAudio();
  if (page.index !== currentPage().index) {
    state.pageIndex = state.book.pages.findIndex((item) => item.index === page.index);
    renderPage();
  }
  showMeaning(word);
  state.activeSentenceIndex = pageSentences(page).findIndex((group) => wordIndex >= group.wordStart && wordIndex < group.wordEnd);
  if (state.activeSentenceIndex < 0) state.activeSentenceIndex = 0;
  renderActiveSentence();
  setSpeakingWord(page, wordIndex);
  const playbackId = state.playbackId;
  await playClip(word.audio, `正在读 “${word.text}”`, { kind: 'word' }, playbackId);
  document.querySelectorAll('.word-hotspot.is-speaking, .dock-word.is-speaking').forEach((node) => node.classList.remove('is-speaking'));
}

async function playSentence(sentenceIndex = state.activeSentenceIndex) {
  const page = currentPage();
  const groups = pageSentences(page);
  const group = groups[sentenceIndex];
  if (!group) return;
  const range = sentenceTiming(page, group);
  if (!range) { setPlaybackStatus('这句话缺少可用的朗读时间标记。'); return; }
  stopAudio();
  state.activeSentenceIndex = sentenceIndex;
  renderActiveSentence();
  const playbackId = state.playbackId;
  await playClip(page.englishAudio, `正在读第 ${sentenceIndex + 1} 句`, { kind: 'sentence', range, page, language: 'en' }, playbackId);
}

async function playPages(pages, mode, scope) {
  stopAudio();
  const playbackId = state.playbackId;
  const queue = Playback.buildQueue(pages, mode);
  if (!queue.length) {
    setPlaybackStatus(scope === 'page' ? '本页没有可播放的音频。' : '这本绘本没有可播放的音频。');
    return;
  }
  const complete = await Playback.playQueue(queue, async (item) => {
    if (playbackId !== state.playbackId) return;
    const pageIndex = state.book.pages.findIndex((candidate) => candidate.index === item.pageIndex);
    const index = pageIndex >= 0 ? pageIndex : item.pageIndex;
    const page = state.book.pages[index];
    if (!page || index < 0 || index >= state.book.pages.length) return true;
    if (state.pageIndex !== index) {
      state.pageIndex = index;
      state.activeSentenceIndex = 0;
      renderPage();
    }
    if (item.language === 'zh') $('active-chinese').textContent = page.zhText || '本页没有中文内容。';
    const languageLabel = item.language === 'zh' ? '中文' : '英语';
    const status = scope === 'book'
      ? (mode === 'bilingual' ? `正在读第 ${page.index} 页${languageLabel}（逐页英中）` : `正在朗读整本${languageLabel}`)
      : (mode === 'bilingual' ? `正在读本页${languageLabel}（英中连读）` : `正在读本页${languageLabel}`);
    const kind = `${scope}-${mode}-${item.language}`;
    return await playClip(item.audioPath, status, { kind, page, language: item.language }, playbackId);
  });
  if (complete && playbackId === state.playbackId) {
    setPlaybackStatus(scope === 'page'
      ? (mode === 'bilingual' ? '本页英中朗读完成。' : '本页朗读完成。')
      : (mode === 'bilingual' ? '整本逐页英中朗读完成。' : '整本朗读完成。'));
  }
}

async function playCurrentPage(mode) {
  await playPages([currentPage()], mode, 'page');
}

async function playBook(mode) {
  await playPages(state.book.pages, mode, 'book');
}

function changeSentence(delta) {
  const groups = pageSentences(currentPage());
  if (!groups.length) return;
  const next = Math.max(0, Math.min(groups.length - 1, state.activeSentenceIndex + delta));
  if (next === state.activeSentenceIndex) return;
  stopAudio();
  state.activeSentenceIndex = next;
  $('word-lookup').hidden = true;
  $('word-prompt').hidden = false;
  renderActiveSentence();
}

function bindControls() {
  slots.forEach((slot) => bindHotspotLayer(slot.hotspots));
  $('previous-page').addEventListener('click', () => goToPage(navTarget(-1)));
  $('next-page').addEventListener('click', () => goToPage(navTarget(1)));
  $('contents-button').addEventListener('click', () => goToPage(0));
  $('play-sentence').addEventListener('click', () => {
    if (state.activeAudio && state.activeAudioKind === 'sentence') { stopAudio(); return; }
    playSentence();
  });
  $('previous-sentence').addEventListener('click', () => changeSentence(-1));
  $('next-sentence').addEventListener('click', () => changeSentence(1));
  $('read-page-en').addEventListener('click', () => playCurrentPage('en'));
  $('read-page-zh').addEventListener('click', () => playCurrentPage('zh'));
  $('read-page-bilingual').addEventListener('click', () => playCurrentPage('bilingual'));
  $('read-book').addEventListener('click', () => playBook($('book-playback-mode').value));
  $('stop-playback').addEventListener('click', stopAudio);
  $('theme-button').addEventListener('click', () => {
    const dialog = $('theme-dialog');
    if (!dialog.open) dialog.showModal();
  });
  $('close-theme-dialog').addEventListener('click', () => $('theme-dialog').close());
  $('theme-dialog').addEventListener('click', (event) => {
    if (event.target === $('theme-dialog')) $('theme-dialog').close();
  });
  document.querySelectorAll('.theme-choice').forEach((button) => {
    button.addEventListener('click', () => {
      setThemeMode(button.dataset.themeMode);
      $('theme-dialog').close();
    });
  });
  $('playback-rate').addEventListener('change', (event) => setPlaybackRate(event.currentTarget.value));
  $('close-meaning').addEventListener('click', () => { $('word-lookup').hidden = true; $('word-prompt').hidden = false; });
  $('reader-main').addEventListener('touchstart', (event) => {
    if (event.touches.length === 1) state.touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { passive: true });
  $('reader-main').addEventListener('touchend', (event) => {
    if (!state.touchStart || event.changedTouches.length !== 1) return;
    const dx = event.changedTouches[0].clientX - state.touchStart.x;
    const dy = event.changedTouches[0].clientY - state.touchStart.y;
    state.touchStart = null;
    if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.3) goToPage(navTarget(dx < 0 ? 1 : -1));
  }, { passive: true });
  window.addEventListener('resize', () => {
    if (!state.book) return;
    renderPage();
  });
  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target?.closest('button, input, textarea, select')) return;
    if (event.key === 'ArrowLeft') goToPage(navTarget(-1));
    if (event.key === 'ArrowRight') goToPage(navTarget(1));
  });
  state.resizeObserver = new ResizeObserver(updateImageFit);
  state.resizeObserver.observe($('book-stage'));
}

async function start() {
  bindControls();
  setPlaybackRate(savedPlaybackRate(), false);
  try {
    const book = await BookData.loadBookData({
      embeddedText: $('embedded-book-data')?.textContent || '',
      protocol: window.location.protocol,
    });
    state.book = book;
    applyTheme(book);
    document.title = `${book.title} · 互动绘本`;
    $('reader-shell').setAttribute('aria-label', `${book.title}互动绘本`);
    renderPage();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (window.location.protocol === 'file:') {
      const recovery = detail.includes('请完整解压')
        ? ''
        : '请完整解压压缩包后，双击根目录 index.html；如仍失败，请使用新版 TapBook 重新打包。';
      reportFatal(`无法载入绘本数据：${detail}${recovery ? `。${recovery}` : ''}`);
      return;
    }
    reportFatal(`无法载入绘本数据：${detail}。请通过 HTTP 服务打开包含 book.json 的静态目录。`);
  }
}

start();
