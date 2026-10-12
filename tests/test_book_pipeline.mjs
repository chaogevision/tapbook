import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(skillRoot, '../..');
const scripts = path.join(skillRoot, 'scripts');
const python = process.env.PYTHON || path.join(repoRoot, '.venv-edge/bin/python');

const fakeEdgeTts = `
import os

async def list_voices():
    return [
        {"ShortName": "en-US-Test", "Locale": "en-US", "Gender": "Female"},
        {"ShortName": "zh-CN-Test", "Locale": "zh-CN", "Gender": "Female"},
    ]

class Communicate:
    def __init__(self, text, voice, rate="+0%", volume="+0%", pitch="+0Hz", boundary="SentenceBoundary"):
        self.text = text
        self.voice = voice
        self.boundary = boundary
        counter = os.environ.get("FAKE_TTS_COUNTER")
        if counter:
            with open(counter, "a", encoding="utf-8") as handle:
                handle.write(voice + "\\n")

    async def stream(self):
        yield {"type": "audio", "data": b"FAKE-MP3-" + self.voice.encode()}
        if os.environ.get("FAKE_TTS_FAIL") == "1":
            raise RuntimeError("simulated service failure")
        if self.boundary != "WordBoundary":
            yield {"type": "SentenceBoundary", "offset": 0, "duration": 5000000, "text": self.text}
            return
        for index, word in enumerate(self.text.split()):
            yield {"type": "WordBoundary", "offset": index * 5000000, "duration": 4000000, "text": word}
`;

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'picturebook-pipeline-test-'));
  const work = path.join(root, 'work');
  const fake = path.join(root, 'fake-python');
  mkdirSync(path.join(work, 'assets'), { recursive: true });
  mkdirSync(fake);
  writeFileSync(path.join(work, 'assets/page-001.jpg'), 'test image bytes');
  writeFileSync(path.join(work, 'assets/reader-background.jpg'), 'test background bytes');
  writeFileSync(path.join(work, 'assets/reader-background-portrait.jpg'), 'test portrait background bytes');
  writeFileSync(path.join(fake, 'edge_tts.py'), fakeEdgeTts);
  const book = {
    schemaVersion: 1,
    title: 'Test Book',
    sourceLanguage: 'en',
    translationLanguage: 'zh-CN',
    voices: { en: 'en-US-Test', zh: 'zh-CN-Test' },
    readerTheme: { preset: 'construction', source: 'auto', confidence: 'high', reason: 'The story follows a red truck on a road.', backgroundImage: 'assets/reader-background.jpg', backgroundImagePortrait: 'assets/reader-background-portrait.jpg' },
    presentation: { pageMode: 'facing-pages' },
    pages: [{
      index: 1,
      sourcePdfPage: 1,
      image: 'assets/page-001.jpg',
      alt: 'A red truck on a road.',
      kind: 'story',
      reviewStatus: 'verified',
      enText: 'A red truck rolls by.',
      zhText: '一辆红色卡车开过。',
      sentences: [{ wordStart: 0, wordEnd: 5, translationZh: '一辆红色卡车开过。' }],
      words: [
        { text: 'A', lemma: 'a', meaningZh: '一辆（冠词）', box: { x: 0.03, y: 0.2, w: 0.04, h: 0.08 }, audio: '' },
        { text: 'red', lemma: 'red', meaningZh: '红色的', box: { x: 0.1, y: 0.2, w: 0.1, h: 0.08 }, audio: '' },
        { text: 'truck.', lemma: 'truck', meaningZh: '卡车', box: { x: 0.3, y: 0.2, w: 0.12, h: 0.08 }, audio: '' },
        { text: 'rolls', lemma: 'roll', meaningZh: '滚动；驶过', box: { x: 0.45, y: 0.2, w: 0.1, h: 0.08 }, audio: '' },
        { text: 'by.', lemma: 'by', meaningZh: '经过', box: { x: 0.6, y: 0.2, w: 0.06, h: 0.08 }, audio: '' },
      ],
      englishAudio: null,
      chineseAudio: null,
      wordTimings: [],
    }],
  };
  writeFileSync(path.join(work, 'book.json'), JSON.stringify(book, null, 2));
  writeFileSync(path.join(work, 'render-manifest.json'), JSON.stringify({
    pageCount: 1,
    pages: [{ sourcePdfPage: 1, image: 'assets/page-001.jpg', width: 2000, height: 1000 }],
  }));
  return { root, work, fake, counter: path.join(root, 'synthesis.log') };
}

function runPython(scriptName, args, fx, extraEnv = {}) {
  return spawnSync(python, [path.join(scripts, scriptName), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: fx.fake, FAKE_TTS_COUNTER: fx.counter, ...extraEnv },
  });
}

test('audio generation writes word/page assets and reuses matching cache entries', () => {
  const fx = makeFixture();
  try {
    const args = ['build', path.join(fx.work, 'book.json'), '--root', fx.work, '--voice-en', 'en-US-Test', '--voice-zh', 'zh-CN-Test'];
    let result = runPython('generate_audio.py', args, fx);
    assert.equal(result.status, 0, result.stderr);
    const book = JSON.parse(readFileSync(path.join(fx.work, 'book.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(path.join(fx.work, 'audio/manifest.json'), 'utf8'));
    assert.match(book.pages[0].words[0].audio, /^audio\/words\/en\/.+\.mp3$/);
    assert.match(book.pages[0].englishAudio, /^audio\/pages\/en-001\.mp3$/);
    assert.match(book.pages[0].chineseAudio, /^audio\/pages\/zh-001\.mp3$/);
    assert.equal(book.pages[0].wordTimings.length, 5);
    assert.ok(Object.keys(manifest.files).length >= 4);
    const callsAfterFirstRun = readFileSync(fx.counter, 'utf8').trim().split('\n').length;

    result = runPython('generate_audio.py', args, fx);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(fx.counter, 'utf8').trim().split('\n').length, callsAfterFirstRun);

    result = runPython('generate_audio.py', [
      'build', path.join(fx.work, 'book.json'), '--root', fx.work,
      '--voice-en', 'en-US-Changed', '--voice-zh', 'zh-CN-Test',
    ], fx);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(fx.counter, 'utf8').trim().split('\n').length > callsAfterFirstRun);

    result = runPython('validate_book.py', [path.join(fx.work, 'book.json'), '--root', fx.work], fx);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const qa = JSON.parse(readFileSync(path.join(fx.work, 'qa-report.json'), 'utf8'));
    assert.equal(qa.status, 'passed');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('failed synthesis removes partial files and reports failure', () => {
  const fx = makeFixture();
  try {
    const result = runPython('generate_audio.py', [
      'build', path.join(fx.work, 'book.json'), '--root', fx.work,
      '--voice-en', 'en-US-Test', '--voice-zh', 'zh-CN-Test', '--retries', '1',
    ], fx, { FAKE_TTS_FAIL: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /simulated service failure/);
    const files = [];
    const visit = (folder) => {
      for (const entry of readdirSync(folder)) {
        const full = path.join(folder, entry);
        if (statSync(full).isDirectory()) visit(full);
        else files.push(full);
      }
    };
    visit(fx.work);
    assert.ok(files.some((file) => file.endsWith('audio/manifest.json')));
    assert.ok(files.every((file) => !file.endsWith('.part')));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('regenerates English page audio when cached word timings are incomplete', () => {
  const fx = makeFixture();
  try {
    const args = ['build', path.join(fx.work, 'book.json'), '--root', fx.work, '--voice-en', 'en-US-Test', '--voice-zh', 'zh-CN-Test'];
    let result = runPython('generate_audio.py', args, fx);
    assert.equal(result.status, 0, result.stderr);
    const manifestPath = path.join(fx.work, 'audio/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.files['audio/pages/en-001.mp3'].wordTimings = [];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const callsBeforeRepair = readFileSync(fx.counter, 'utf8').trim().split('\n').length;

    result = runPython('generate_audio.py', args, fx);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(fx.counter, 'utf8').trim().split('\n').length, callsBeforeRepair + 1);
    const book = JSON.parse(readFileSync(path.join(fx.work, 'book.json'), 'utf8'));
    assert.equal(book.pages[0].wordTimings.length, 5);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('validator reports invalid boxes, missing word meanings, and untranslated English pages', () => {
  const fx = makeFixture();
  try {
    const book = JSON.parse(readFileSync(path.join(fx.work, 'book.json'), 'utf8'));
    book.pages[0].zhText = '';
    book.pages[0].words[0].meaningZh = '';
    book.pages[0].words[1].box.x = 0.95;
    book.pages[0].words[1].box.w = 0.2;
    writeFileSync(path.join(fx.work, 'book.json'), JSON.stringify(book, null, 2));
    const result = runPython('validate_book.py', [path.join(fx.work, 'book.json'), '--root', fx.work], fx);
    assert.equal(result.status, 1);
    const qa = JSON.parse(readFileSync(path.join(fx.work, 'qa-report.json'), 'utf8'));
    assert.equal(qa.status, 'failed');
    const codes = qa.errors.map((error) => error.code);
    assert.ok(codes.includes('missing_translation'));
    assert.ok(codes.includes('missing_word_meaning'));
    assert.ok(codes.includes('invalid_word_box'));
    assert.equal(qa.checks.touchTargets, false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('validator audits compact printed boxes at phone and tablet display widths', () => {
  const fx = makeFixture();
  try {
    const generated = runPython('generate_audio.py', [
      'build', path.join(fx.work, 'book.json'), '--root', fx.work,
      '--voice-en', 'en-US-Test', '--voice-zh', 'zh-CN-Test',
    ], fx);
    assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    const result = runPython('validate_book.py', [path.join(fx.work, 'book.json'), '--root', fx.work], fx);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const qa = JSON.parse(readFileSync(path.join(fx.work, 'qa-report.json'), 'utf8'));
    assert.equal(qa.checks.touchTargets, true);
    assert.deepEqual(qa.touchTargetAudit.referenceDisplayWidths, [320, 600, 900]);
    assert.equal(qa.touchTargetAudit.minimumCssPixels, 44);
    assert.equal(qa.touchTargetAudit.wordCount, 5);
    assert.deepEqual(qa.touchTargetAudit.wordsNeedingExpansion, [5, 5, 5]);
    assert.ok(qa.warnings.some((warning) => warning.code === 'small_printed_word_boxes' && warning.page === 1));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('validator blocks word boxes with indistinguishable touch centers', () => {
  const fx = makeFixture();
  try {
    const book = JSON.parse(readFileSync(path.join(fx.work, 'book.json'), 'utf8'));
    book.pages[0].words[1].box = { ...book.pages[0].words[0].box };
    writeFileSync(path.join(fx.work, 'book.json'), JSON.stringify(book, null, 2));
    const generated = runPython('generate_audio.py', [
      'build', path.join(fx.work, 'book.json'), '--root', fx.work,
      '--voice-en', 'en-US-Test', '--voice-zh', 'zh-CN-Test',
    ], fx);
    assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    const result = runPython('validate_book.py', [path.join(fx.work, 'book.json'), '--root', fx.work], fx);
    assert.equal(result.status, 1);
    const qa = JSON.parse(readFileSync(path.join(fx.work, 'qa-report.json'), 'utf8'));
    assert.ok(qa.errors.some((error) => error.code === 'ambiguous_word_hotspots' && error.page === 1));
    assert.equal(qa.checks.touchTargets, false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('validator blocks unsafe paths, missing audio, and invalid narration timings', () => {
  const fx = makeFixture();
  try {
    const book = JSON.parse(readFileSync(path.join(fx.work, 'book.json'), 'utf8'));
    book.pages[0].image = '../outside.jpg';
    book.pages[0].words[0].audio = '';
    book.pages[0].englishAudio = null;
    book.pages[0].wordTimings = [{ text: 'wrong', start: -1, duration: 0 }];
    writeFileSync(path.join(fx.work, 'book.json'), JSON.stringify(book, null, 2));

    const result = runPython('validate_book.py', [path.join(fx.work, 'book.json'), '--root', fx.work], fx);
    assert.equal(result.status, 1);
    const qa = JSON.parse(readFileSync(path.join(fx.work, 'qa-report.json'), 'utf8'));
    const codes = qa.errors.map((error) => error.code);
    assert.ok(codes.includes('missing_page_image'));
    assert.ok(codes.includes('missing_word_audio'));
    assert.ok(codes.includes('missing_page_audio'));
    assert.ok(codes.includes('invalid_word_timings'));
    assert.ok(codes.includes('timing_text_mismatch'));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('validator rejects duplicate output and source page indexes', () => {
  const fx = makeFixture();
  try {
    const book = JSON.parse(readFileSync(path.join(fx.work, 'book.json'), 'utf8'));
    book.pages.push({ ...book.pages[0] });
    writeFileSync(path.join(fx.work, 'book.json'), JSON.stringify(book, null, 2));

    const result = runPython('validate_book.py', [path.join(fx.work, 'book.json'), '--root', fx.work], fx);
    assert.equal(result.status, 1);
    const qa = JSON.parse(readFileSync(path.join(fx.work, 'qa-report.json'), 'utf8'));
    const codes = qa.errors.map((error) => error.code);
    assert.ok(codes.includes('duplicate_page_index'));
    assert.ok(codes.includes('duplicate_source_page'));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('validator requires a known book theme and complete sentence translations', () => {
  const fx = makeFixture();
  try {
    const book = JSON.parse(readFileSync(path.join(fx.work, 'book.json'), 'utf8'));
    book.readerTheme.preset = 'snowman';
    book.pages[0].sentences = [{ wordStart: 1, wordEnd: 4, translationZh: '' }];
    writeFileSync(path.join(fx.work, 'book.json'), JSON.stringify(book, null, 2));
    const result = runPython('validate_book.py', [path.join(fx.work, 'book.json'), '--root', fx.work], fx);
    assert.equal(result.status, 1);
    const qa = JSON.parse(readFileSync(path.join(fx.work, 'qa-report.json'), 'utf8'));
    const codes = qa.errors.map((error) => error.code);
    assert.ok(codes.includes('invalid_reader_theme'));
    assert.ok(codes.includes('invalid_sentence_translation'));
    assert.ok(codes.includes('sentence_coverage_mismatch'));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('validator still requires a configured custom theme image to exist', () => {
  const fx = makeFixture();
  try {
    const book = JSON.parse(readFileSync(path.join(fx.work, 'book.json'), 'utf8'));
    book.readerTheme.backgroundImage = 'assets/missing-background.jpg';
    writeFileSync(path.join(fx.work, 'book.json'), JSON.stringify(book, null, 2));
    const result = runPython('validate_book.py', [path.join(fx.work, 'book.json'), '--root', fx.work], fx);
    assert.equal(result.status, 1);
    const qa = JSON.parse(readFileSync(path.join(fx.work, 'qa-report.json'), 'utf8'));
    assert.ok(qa.errors.some((error) => error.code === 'missing_theme_background'));
    assert.equal(qa.checks.themeBackground, false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('validator accepts the bundled default theme when a custom background is omitted', () => {
  const fx = makeFixture();
  try {
    const book = JSON.parse(readFileSync(path.join(fx.work, 'book.json'), 'utf8'));
    delete book.readerTheme.backgroundImage;
    delete book.readerTheme.backgroundImagePortrait;
    writeFileSync(path.join(fx.work, 'book.json'), JSON.stringify(book, null, 2));
    let result = runPython('generate_audio.py', [
      'build', path.join(fx.work, 'book.json'), '--root', fx.work,
      '--voice-en', 'en-US-Test', '--voice-zh', 'zh-CN-Test',
    ], fx);
    assert.equal(result.status, 0, result.stderr);
    result = runPython('validate_book.py', [path.join(fx.work, 'book.json'), '--root', fx.work], fx);
    assert.equal(result.status, 0, result.stderr);
    const qa = JSON.parse(readFileSync(path.join(fx.work, 'qa-report.json'), 'utf8'));
    assert.equal(qa.checks.themeBackground, true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('packager writes a portable reader directory and ZIP without absolute paths', () => {
  const fx = makeFixture();
  try {
    let result = runPython('generate_audio.py', [
      'build', path.join(fx.work, 'book.json'), '--root', fx.work,
      '--voice-en', 'en-US-Test', '--voice-zh', 'zh-CN-Test',
    ], fx);
    assert.equal(result.status, 0, result.stderr);
    result = runPython('validate_book.py', [path.join(fx.work, 'book.json'), '--root', fx.work], fx);
    assert.equal(result.status, 0, result.stderr);
    const output = path.join(fx.root, 'published');
    const archive = path.join(fx.root, 'published.zip');
    result = runPython('package_book.py', [fx.work, '--output-dir', output, '--zip', archive], fx);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(readFileSync(path.join(output, 'index.html'), 'utf8').includes('reader.js'));
    assert.ok(readFileSync(path.join(output, 'assets/page-001.jpg'), 'utf8').length > 0);
    assert.ok(readFileSync(path.join(output, 'assets/reader-background.jpg'), 'utf8').length > 0);
    assert.ok(readFileSync(path.join(output, 'assets/reader-background-portrait.jpg'), 'utf8').length > 0);
    assert.ok(statSync(path.join(output, 'themes/backgrounds/construction-landscape.webp')).size > 0);
    assert.ok(statSync(path.join(output, 'themes/backgrounds/construction-portrait.webp')).size > 0);
    assert.ok(readFileSync(path.join(output, 'themes/icons/winter.svg'), 'utf8').includes('<svg'));
    assert.ok(readFileSync(path.join(output, 'playback-utils.js'), 'utf8').includes('buildQueue'));
    assert.ok(statSync(path.join(output, 'themes/backgrounds/default-landscape.webp')).size > 0);
    assert.ok(statSync(path.join(output, 'themes/backgrounds/default-portrait.webp')).size > 0);
    assert.match(readFileSync(path.join(output, 'reader.js'), 'utf8'), /theme-dialog/);
    assert.match(readFileSync(path.join(output, 'index.html'), 'utf8'), /read-page-bilingual/);
    assert.match(readFileSync(path.join(output, 'index.html'), 'utf8'), /hotspot-utils\.js/);
    assert.ok(readFileSync(path.join(output, 'hotspot-utils.js'), 'utf8').includes('nearestAtPoint'));
    assert.match(readFileSync(path.join(output, 'index.html'), 'utf8'), /playback-rate/);
    assert.match(readFileSync(path.join(output, 'index.html'), 'utf8'), /逐页英中/);
    const list = spawnSync(python, ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print("\\n".join(z.namelist()))', archive], { encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /index\.html/);
    assert.match(list.stdout, /themes\/backgrounds\/winter-landscape\.webp/);
    assert.match(list.stdout, /themes\/backgrounds\/winter-portrait\.webp/);
    assert.match(list.stdout, /themes\/icons\/winter\.svg/);
    assert.match(list.stdout, /themes\/icons\/book\.svg/);
    assert.match(list.stdout, /themes\/backgrounds\/forest-landscape\.webp/);
    assert.doesNotMatch(list.stdout, /themes\/(winter|vehicles|construction|ocean|forest|farm|space|storybook)\.svg/);
    assert.match(list.stdout, /playback-utils\.js/);
    assert.match(list.stdout, /hotspot-utils\.js/);
    assert.match(list.stdout, /themes\/backgrounds\/default-landscape\.webp/);
    assert.match(list.stdout, /themes\/backgrounds\/default-portrait\.webp/);
    assert.match(list.stdout, /assets\/reader-background\.jpg/);
    assert.match(list.stdout, /assets\/reader-background-portrait\.jpg/);
    assert.doesNotMatch(list.stdout, /(^|\n)\//);
    assert.doesNotMatch(list.stdout, /\.pdf$/m);

    writeFileSync(path.join(output, 'stale-generated-file.txt'), 'old output');
    result = runPython('package_book.py', [fx.work, '--output-dir', output, '--zip', archive, '--replace-generated'], fx);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!readdirSync(output).includes('stale-generated-file.txt'));
    assert.ok(readFileSync(path.join(output, 'index.html'), 'utf8').includes('reader.js'));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
