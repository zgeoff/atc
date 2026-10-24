import { expect, test } from 'bun:test';
import { buildSubscriptionID } from './build-subscription-id';

test('it derives the same id from the same key', () => {
  const key = {
    clientID: 'client-one',
    url: 'https://hooks.example.com/hook',
    name: 'session.turn_done',
    arguments: '{}',
  };

  expect(buildSubscriptionID(key)).toBe(buildSubscriptionID({ ...key }));
});

test('it derives a sub_ id of 32 hex characters', () => {
  expect(
    buildSubscriptionID({
      clientID: 'client-one',
      url: 'https://hooks.example.com/hook',
      name: 'session.turn_done',
      arguments: '{}',
    }),
  ).toMatch(/^sub_[0-9a-f]{32}$/u);
});

test.each([
  ['client', { clientID: 'client-two' }],
  ['callback URL', { url: 'https://hooks.example.com/other' }],
  ['event name', { name: 'session.needs_input' }],
  ['arguments', { arguments: '{"session":"s-1"}' }],
])('it derives another id for another %s', (_label, change) => {
  const key = {
    clientID: 'client-one',
    url: 'https://hooks.example.com/hook',
    name: 'session.turn_done',
    arguments: '{}',
  };

  expect(buildSubscriptionID({ ...key, ...change })).not.toBe(buildSubscriptionID(key));
});
