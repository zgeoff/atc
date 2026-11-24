import { expect, test } from 'bun:test';
import { buildMockEventsPage } from './build-mock-events-page';
import { buildMockFleetEvent } from './build-mock-fleet-event';

test('it builds a page with one event for each cursor and no daemon state', () => {
  expect(buildMockEventsPage('g1.b', ['g1.a'])).toStrictEqual({
    events: [buildMockFleetEvent('g1.a')],
    cursor: 'g1.b',
    more: false,
    unavailable: [],
    started: [],
    truncated: [],
  });
});

test('it lets the override replace a field of the page', () => {
  expect(buildMockEventsPage('g1.b', [], { more: true, unavailable: ['laptop'] })).toMatchObject({
    more: true,
    unavailable: ['laptop'],
  });
});
