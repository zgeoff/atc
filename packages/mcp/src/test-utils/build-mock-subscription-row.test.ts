import { expect, test } from 'bun:test';
import { buildMockSubscriptionRow } from './build-mock-subscription-row';

test('it builds a default subscription row', () => {
  expect(buildMockSubscriptionRow()).toStrictEqual({
    id: expect.toStartWith('sub_'),
    client_id: expect.toBeString(),
    url: expect.toBeString(),
    name: 'session.turn_done',
    arguments: '{}',
    secret: expect.toStartWith('whsec_'),
    position: expect.toBeString(),
    refresh_before: expect.toBeString(),
    created_at: expect.toBeString(),
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockSubscriptionRow({
      id: 'sub-one',
      client_id: 'client-1',
      url: 'https://hooks.example.com/hook',
      position: 'cursor-1',
      refresh_before: '2026-10-14T13:00:00.000Z',
      created_at: '2026-10-14T12:00:00.000Z',
    }),
  ).toStrictEqual({
    id: 'sub-one',
    client_id: 'client-1',
    url: 'https://hooks.example.com/hook',
    name: 'session.turn_done',
    arguments: '{}',
    secret: expect.toStartWith('whsec_'),
    position: 'cursor-1',
    refresh_before: '2026-10-14T13:00:00.000Z',
    created_at: '2026-10-14T12:00:00.000Z',
  });
});
