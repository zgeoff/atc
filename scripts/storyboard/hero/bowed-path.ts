import type { Spot } from './layout.ts';

// A curve that bows `bow` px to the right of its direction of travel at its middle.
export function buildBowedPath(from: Spot, to: Spot, bow: number): string {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const length = Math.hypot(deltaX, deltaY);
  const controlX = (from.x + to.x) / 2 + (-deltaY / length) * bow * 2;
  const controlY = (from.y + to.y) / 2 + (deltaX / length) * bow * 2;

  return `M${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${controlX.toFixed(1)} ${controlY.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}
