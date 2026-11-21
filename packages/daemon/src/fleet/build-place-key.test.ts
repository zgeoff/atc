import { expect, test } from 'bun:test';
import type { PlaceParts } from '@atc/plugin-api';
import { buildPlaceKey } from './build-place-key';

function setupTest() {
  return { buildKey: buildPlaceKey };
}

interface KeyRow {
  readonly provider: string;
  readonly placeParts: PlaceParts | undefined;
  readonly daemonID: string;
  readonly targetID: string;
  readonly savedIdentity?: string;
}

test.each<[string, KeyRow, string]>([
  [
    'a shared place',
    {
      provider: 'cloud',
      placeParts: {
        scope: 'shared',
        version: 'place-v1',
        parts: { url: 'https://svc.example.dev' },
      },
      daemonID: 'd1',
      targetID: 'first',
    },
    'cloud:place-v1:534c6df68a693f9c',
  ],
  [
    'the same shared place on another daemon and target',
    {
      provider: 'cloud',
      placeParts: {
        scope: 'shared',
        version: 'place-v1',
        parts: { url: 'https://svc.example.dev' },
      },
      daemonID: 'd2',
      targetID: 'second',
    },
    'cloud:place-v1:534c6df68a693f9c',
  ],
  [
    'parts whose keys arrive in another order, at every depth',
    {
      provider: 'cloud',
      placeParts: {
        scope: 'shared',
        version: 'place-v1',
        parts: { beta: { gamma: 2, delta: 3 }, alpha: 1 },
      },
      daemonID: 'd1',
      targetID: 'first',
    },
    'cloud:place-v1:949676d3af44faee',
  ],
  [
    'parts that list the keys in sorted order',
    {
      provider: 'cloud',
      placeParts: {
        scope: 'shared',
        version: 'place-v1',
        parts: { alpha: 1, beta: { delta: 3, gamma: 2 } },
      },
      daemonID: 'd1',
      targetID: 'first',
    },
    'cloud:place-v1:949676d3af44faee',
  ],
  [
    'another version of the same parts',
    {
      provider: 'cloud',
      placeParts: {
        scope: 'shared',
        version: 'place-v2',
        parts: { alpha: 1, beta: { delta: 3, gamma: 2 } },
      },
      daemonID: 'd1',
      targetID: 'first',
    },
    'cloud:place-v2:949676d3af44faee',
  ],
  [
    'daemon scope',
    { provider: 'sprites', placeParts: { scope: 'daemon' }, daemonID: 'd1', targetID: 'sp' },
    'daemon:d1:sp',
  ],
  [
    'a provider with no rule',
    { provider: 'local-pty', placeParts: undefined, daemonID: 'd1', targetID: 'local' },
    'daemon:d1:local',
  ],
  [
    'a daemon-scope target whose id holds a colon',
    { provider: 'docker', placeParts: undefined, daemonID: 'd1', targetID: 'box:old' },
    'daemon:d1:box%3Aold',
  ],
  [
    'a session kept from an earlier identity of its target',
    {
      provider: 'cloud',
      placeParts: undefined,
      daemonID: 'd1',
      targetID: 'box',
      savedIdentity: 'cloud:old',
    },
    'daemon:d1:box:cloud%3Aold',
  ],
])('it builds the key of %s', (_title, row, expected) => {
  const ctx = setupTest();

  expect(ctx.buildKey(row)).toBe(expected);
});
