import { expect, test } from 'bun:test';
import { pickWordmark } from './pick-wordmark';
import type { Wordmark } from './types';

test.each<readonly [number, number, Wordmark]>([
  [164, 50, { kind: 'outline', size: 's10' }],
  [300, 80, { kind: 'outline', size: 's10' }],
  [163, 50, { kind: 'outline', size: 'xs8' }],
  [164, 49, { kind: 'outline', size: 'xs8' }],
  [160, 45, { kind: 'outline', size: 'xs8' }],
  [136, 40, { kind: 'outline', size: 'xs8' }],
  [135, 40, { kind: 'bitmap' }],
  [136, 39, { kind: 'bitmap' }],
  [113, 21, { kind: 'bitmap' }],
  [30, 10, { kind: 'bitmap' }],
  [29, 10, { kind: 'text' }],
  [30, 9, { kind: 'text' }],
  [24, 8, { kind: 'text' }],
  [200, 9, { kind: 'text' }],
])('#pickWordmark gives the right wordmark at %ix%i', (cols, rows, expected) => {
  expect(pickWordmark({ cols, rows })).toStrictEqual(expected);
});
