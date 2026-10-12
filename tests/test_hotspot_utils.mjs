import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const readerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/reader');
const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
const utilityPath = path.join(readerDir, 'hotspot-utils.js');
if (existsSync(utilityPath)) vm.runInNewContext(readFileSync(utilityPath, 'utf8'), sandbox);
const hotspots = sandbox.PictureBookHotspots;

function requireHotspotUtils() {
  assert.equal(typeof hotspots?.targetRect, 'function', 'reader must expose touch-target geometry');
  assert.equal(typeof hotspots?.nearestAtPoint, 'function', 'reader must expose overlap-aware tap routing');
  return hotspots;
}

test('short printed words receive centered 44px touch targets on phone and tablet layouts', () => {
  const api = requireHotspotUtils();
  for (const [width, height] of [[320, 160], [600, 300], [900, 450]]) {
    const target = api.targetRect({ x: 0.5, y: 0.4, w: 0.016, h: 0.036 }, width, height);
    assert.equal(target.width, 44);
    assert.equal(target.height, 44);
    assert.ok(Math.abs(target.centerX - width * (0.5 + 0.008)) < 1e-9);
    assert.ok(Math.abs(target.centerY - height * (0.4 + 0.018)) < 1e-9);
    assert.ok(target.left >= 0 && target.top >= 0);
    assert.ok(target.left + target.width <= width);
    assert.ok(target.top + target.height <= height);
  }
});

test('larger printed words keep their exact geometry while edge targets stay inside the page', () => {
  const api = requireHotspotUtils();
  const large = api.targetRect({ x: 0.2, y: 0.2, w: 0.2, h: 0.35 }, 320, 160);
  assert.deepEqual(JSON.parse(JSON.stringify(large)), {
    left: 64,
    top: 32,
    width: 64,
    height: 56,
    centerX: 96,
    centerY: 60,
    wordLeft: 0,
    wordTop: 0,
    wordWidth: 64,
    wordHeight: 56,
  });

  const edge = api.targetRect({ x: 0, y: 0, w: 0.01, h: 0.02 }, 320, 160);
  assert.equal(edge.left, 0);
  assert.equal(edge.top, 0);
  assert.equal(edge.width, 44);
  assert.equal(edge.height, 44);
  assert.ok(edge.centerX < edge.width && edge.centerY < edge.height);
});

test('overlapping touch targets route a tap to the nearest printed word center', () => {
  const api = requireHotspotUtils();
  const candidates = [
    { id: 'left', hitRect: { left: 0, top: 0, right: 44, bottom: 44 }, centerX: 22, centerY: 22 },
    { id: 'right', hitRect: { left: 30, top: 0, right: 74, bottom: 44 }, centerX: 52, centerY: 22 },
  ];
  assert.equal(api.nearestAtPoint(candidates, 25, 22).id, 'left');
  assert.equal(api.nearestAtPoint(candidates, 40, 22).id, 'right');
  assert.equal(api.nearestAtPoint(candidates, 90, 22), null);
});
