import { SUPERSAMPLES } from './constants';
import { padToEvenRows } from './pad-to-even-rows';
import type { Coverage, OutlineSize } from './types';

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// How much of each pixel the outline wordmark covers. Every straight edge lies on a whole pixel, so
// only the curves of the bowls get part-covered pixels.
export function buildOutlineCoverage(size: OutlineSize): Coverage {
  const aWidth = size.aWidth;
  const tLeft = aWidth + size.track;
  const cLeft = tLeft + size.tWidth + size.track;
  const width = cLeft + size.cWidth;
  const height = size.ascender + size.xHeight;
  const xTop = size.ascender;
  const aBowl: Rect = { x: 0, y: xTop, width: aWidth, height: size.xHeight };

  const aStem: Rect = {
    x: aWidth - size.stroke,
    y: xTop,
    width: size.stroke,
    height: size.xHeight,
  };

  const tBar: Rect = {
    x: tLeft,
    y: xTop,
    width: size.tWidth,
    height: size.stroke,
  };

  const tStem: Rect = {
    x: tLeft + size.tStem,
    y: 0,
    width: size.stroke,
    height,
  };

  const cBowl: Rect = {
    x: cLeft,
    y: xTop,
    width: size.cWidth,
    height: size.xHeight,
  };

  const cCut: Rect = {
    x: cLeft + size.cWidth - size.stroke,
    y: xTop + (size.xHeight - size.gap) / 2,
    width: size.stroke,
    height: size.gap,
  };

  const isInside = (x: number, y: number): boolean =>
    isInRing(x, y, aBowl, size) ||
    isInRect(x, y, aStem) ||
    isInRect(x, y, tBar) ||
    isInRect(x, y, tStem) ||
    (isInRing(x, y, cBowl, size) && !isInRect(x, y, cCut));

  const buildRow = (row: number): number[] =>
    Array.from({ length: width }, (_, col) => measureCoverage(col, row, isInside));

  return padToEvenRows(Array.from({ length: height }, (_, row) => buildRow(row)));
}

// the bowl's rounded rectangle, less the same shape drawn one stroke smaller
function isInRing(x: number, y: number, bowl: Rect, size: OutlineSize): boolean {
  const inner: Rect = {
    x: bowl.x + size.stroke,
    y: bowl.y + size.stroke,
    width: bowl.width - 2 * size.stroke,
    height: bowl.height - 2 * size.stroke,
  };

  return (
    measureRoundedRect(x, y, bowl, size.radius) <= 0 &&
    measureRoundedRect(x, y, inner, Math.max(0, size.radius - size.stroke)) > 0
  );
}

// The signed distance from a point to a rounded rectangle: negative inside, positive outside.
function measureRoundedRect(x: number, y: number, rect: Rect, radius: number): number {
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  const dx = Math.abs(x - (rect.x + halfWidth)) - (halfWidth - radius);
  const dy = Math.abs(y - (rect.y + halfHeight)) - (halfHeight - radius);

  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
}

function isInRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function measureCoverage(
  col: number,
  row: number,
  isInside: (x: number, y: number) => boolean,
): number {
  let covered = 0;

  for (let sampleY = 0; sampleY < SUPERSAMPLES; sampleY += 1) {
    for (let sampleX = 0; sampleX < SUPERSAMPLES; sampleX += 1) {
      const x = col + (sampleX + 0.5) / SUPERSAMPLES;
      const y = row + (sampleY + 0.5) / SUPERSAMPLES;

      covered += isInside(x, y) ? 1 : 0;
    }
  }

  return covered / (SUPERSAMPLES * SUPERSAMPLES);
}
