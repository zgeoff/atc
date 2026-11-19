import { expect, test } from 'bun:test';
import { createDemuxer } from './create-demuxer';
import type { StreamName } from './types';

function setupTest() {
  const frames: [string, StreamName][] = [];

  const demuxer = createDemuxer((data, stream) => {
    frames.push([new TextDecoder().decode(data), stream]);
  });

  return { frames, demuxer };
}

test('#createDemuxer reports each frame with its stream', () => {
  const ctx = setupTest();

  ctx.demuxer.feed(Buffer.from('\u0001\0\0\0\0\0\0\u0003out', 'latin1'));
  ctx.demuxer.feed(Buffer.from('\u0002\0\0\0\0\0\0\u0003err', 'latin1'));

  expect(ctx.frames).toStrictEqual([
    ['out', 'stdout'],
    ['err', 'stderr'],
  ]);
});

test('#createDemuxer joins a frame that arrives in pieces', () => {
  const ctx = setupTest();
  const frame = Buffer.from('\u0001\0\0\0\0\0\0\u0005split', 'latin1');

  ctx.demuxer.feed(frame.subarray(0, 5));
  ctx.demuxer.feed(frame.subarray(5, 10));
  ctx.demuxer.feed(frame.subarray(10));

  expect(ctx.frames).toStrictEqual([['split', 'stdout']]);
});

test('#createDemuxer splits two frames that arrive in one chunk', () => {
  const ctx = setupTest();

  ctx.demuxer.feed(Buffer.from('\u0001\0\0\0\0\0\0\u0001a\u0001\0\0\0\0\0\0\u0001b', 'latin1'));

  expect(ctx.frames).toStrictEqual([
    ['a', 'stdout'],
    ['b', 'stdout'],
  ]);
});
