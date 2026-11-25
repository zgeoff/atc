import { expect, test } from 'bun:test';
import { buildMockFleetEvent } from './build-mock-fleet-event';

test('it builds an event that holds the merged cursor and the daemon cursor derived from it', () => {
  expect(buildMockFleetEvent('g1.a')).toStrictEqual({
    cursor: 'g1.a',
    at: 1,
    session: 'build-box.k3f9.s7-m4x2p',
    name: null,
    kind: 'turn_done',
    detail: null,
    origin: { daemon: 'build-box', incarnation: 'k3f9', cursor: 'd-g1.a' },
  });
});
