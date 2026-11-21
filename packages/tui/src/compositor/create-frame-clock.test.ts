import { expect, test } from 'bun:test';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { createFrameClock } from './create-frame-clock';
import type { Layer } from './types';

function setupTest() {
  const clock = buildStubClock(1000);
  const frames: number[] = [];
  const layers: Layer[] = [];

  const frameClock = createFrameClock({
    clock,
    animations: true,
    collectLayers: () => layers,
    drawFrame: () => {
      frames.push(clock.now());
    },
  });

  return { clock, frames, layers, frameClock };
}

test('#request draws one frame for several requests in the same moment', () => {
  const ctx = setupTest();

  ctx.frameClock.request();
  ctx.frameClock.request();
  ctx.clock.advance(1);

  expect(ctx.frames).toStrictEqual([1000]);
});

test('#request stops the clock when every layer answers null', () => {
  const ctx = setupTest();

  ctx.layers.push({ draw: () => {}, nextFrameAt: () => null });
  ctx.frameClock.request();
  ctx.clock.advance(1000);

  expect(ctx.frames).toStrictEqual([1000]);
});

test('#request keeps drawing at the earliest answer while a layer animates', () => {
  const ctx = setupTest();

  ctx.layers.push(
    { draw: () => {}, nextFrameAt: (nowMs) => (nowMs < 1040 ? nowMs + 16 : null) },
    { draw: () => {}, nextFrameAt: (nowMs) => nowMs + 100 },
  );

  ctx.frameClock.request();
  ctx.clock.advance(60);

  expect(ctx.frames.slice(0, 3)).toStrictEqual([1000, 1016, 1032]);
});

test('#stop draws no frame after it', () => {
  const ctx = setupTest();

  ctx.frameClock.request();
  ctx.frameClock.stop();
  ctx.clock.advance(100);

  expect(ctx.frames).toStrictEqual([]);
});
