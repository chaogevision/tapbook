import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(skillRoot, 'scripts', 'render_pdf.py');
const repoRoot = path.resolve(skillRoot, '../..');
const python = process.env.PYTHON || path.join(repoRoot, '.venv-edge/bin/python');

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'picturebook-render-test-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const jpeg = path.join(root, 'one-pixel.jpg');
  writeFileSync(jpeg, Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
  ]));
  const tools = {
    pdfinfo: `#!/bin/sh\nif [ "$1" = "-v" ]; then echo 'pdfinfo version test' >&2; exit 0; fi\necho 'Pages: 2'\necho 'Page size: 72 x 72 pts'\n`,
    pdftotext: `#!/bin/sh\nif [ "$1" = "-v" ]; then echo 'pdftotext version test' >&2; exit 0; fi\nprintf 'Hello world.\\n'\n`,
    pdftoppm: `#!/bin/sh\nif [ "$1" = "-v" ]; then echo 'pdftoppm version test' >&2; exit 0; fi\nwhile [ "$#" -gt 0 ]; do prefix="$1"; shift; done\ncp "$PICTUREBOOK_TEST_JPEG" "$prefix.jpg"\n`,
    tesseract: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'tesseract 5 test'; exit 0; fi\nprintf 'level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n5\\t1\\t1\\t1\\t1\\t1\\t0\\t0\\t1\\t1\\t93\\tHello\\n'\n`,
  };
  for (const [name, content] of Object.entries(tools)) {
    const file = path.join(bin, name);
    writeFileSync(file, content, { mode: 0o755 });
  }
  const input = path.join(root, 'source.pdf');
  writeFileSync(input, '%PDF-1.4 test fixture');
  return { root, bin, input, jpeg };
}

function run(fx, args, pathEntries = [fx.bin]) {
  return spawnSync(python, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: pathEntries.length ? [...pathEntries, process.env.PATH].join(path.delimiter) : '', PICTUREBOOK_TEST_JPEG: fx.jpeg },
  });
}

test('rejects a missing PDF before invoking Poppler', () => {
  const fx = fixture();
  try {
    const result = run(fx, [path.join(fx.root, 'missing.pdf'), '--output-dir', path.join(fx.root, 'out')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /input PDF does not exist/i);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('renders every page, writes text and normalized OCR boxes, and records metadata', () => {
  const fx = fixture();
  const output = path.join(fx.root, 'out');
  try {
    const result = run(fx, [fx.input, '--output-dir', output, '--dpi', '150', '--ocr-lang', 'eng']);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(path.join(output, 'render-manifest.json'), 'utf8'));
    assert.equal(manifest.pageCount, 2);
    assert.deepEqual(manifest.pages.map((page) => page.image), ['assets/page-001.jpg', 'assets/page-002.jpg']);
    assert.ok(manifest.pages.every((page) => page.width === 1 && page.height === 1));
    const ocr = JSON.parse(readFileSync(path.join(output, 'ocr/page-001.json'), 'utf8'));
    assert.equal(ocr.words[0].text, 'Hello');
    assert.deepEqual(ocr.words[0].box, { x: 0, y: 0, w: 1, h: 1 });
    assert.equal(readFileSync(path.join(output, 'source-text/page-001.txt'), 'utf8').trim(), 'Hello world.');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('reports missing Poppler tools with a non-zero result', () => {
  const fx = fixture();
  try {
    const result = run(fx, [fx.input, '--output-dir', path.join(fx.root, 'out')], []);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /pdftoppm.*not found|Poppler/i);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
