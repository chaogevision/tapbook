'use strict';

(function attachPictureBookHotspots(root) {
  const MIN_TOUCH_TARGET = 44;

  function targetRect(box, frameWidth, frameHeight, minSize = MIN_TOUCH_TARGET) {
    const values = [box?.x, box?.y, box?.w, box?.h, frameWidth, frameHeight, minSize].map(Number);
    if (!values.every(Number.isFinite)) return null;
    const [x, y, normalizedWidth, normalizedHeight, width, height, minimum] = values;
    if (x < 0 || y < 0 || normalizedWidth <= 0 || normalizedHeight <= 0 || width <= 0 || height <= 0 || minimum <= 0) return null;

    const wordLeft = x * width;
    const wordTop = y * height;
    const wordWidth = normalizedWidth * width;
    const wordHeight = normalizedHeight * height;
    const targetWidth = Math.min(width, Math.max(wordWidth, minimum));
    const targetHeight = Math.min(height, Math.max(wordHeight, minimum));
    const centerX = wordLeft + wordWidth / 2;
    const centerY = wordTop + wordHeight / 2;
    const left = Math.max(0, Math.min(width - targetWidth, centerX - targetWidth / 2));
    const top = Math.max(0, Math.min(height - targetHeight, centerY - targetHeight / 2));

    return {
      left,
      top,
      width: targetWidth,
      height: targetHeight,
      centerX,
      centerY,
      wordLeft: wordLeft - left,
      wordTop: wordTop - top,
      wordWidth,
      wordHeight,
    };
  }

  function nearestAtPoint(candidates, x, y) {
    const pointX = Number(x);
    const pointY = Number(y);
    if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) return null;

    let nearest = null;
    let nearestDistance = Infinity;
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const rect = candidate?.hitRect;
      if (!rect || pointX < rect.left || pointX > rect.right || pointY < rect.top || pointY > rect.bottom) continue;
      const centerX = Number(candidate.centerX ?? (rect.left + rect.right) / 2);
      const centerY = Number(candidate.centerY ?? (rect.top + rect.bottom) / 2);
      if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) continue;
      const distance = (pointX - centerX) ** 2 + (pointY - centerY) ** 2;
      if (distance < nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  root.PictureBookHotspots = Object.freeze({ MIN_TOUCH_TARGET, targetRect, nearestAtPoint });
}(globalThis));
