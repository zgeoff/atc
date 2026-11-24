import { expect, test } from 'bun:test';
import { buildMockServiceAccess } from './build-mock-service-access';

test('it builds the access of the service client with its principal id and the scopes given', () => {
  expect(buildMockServiceAccess(['read'], 'nightly')).toStrictEqual({
    kind: 'service',
    clientID: 'service:nightly',
    clientName: 'service:nightly',
    scopes: ['read'],
  });
});

test('it names the client ci unless the test names another', () => {
  expect(buildMockServiceAccess([]).clientID).toBe('service:ci');
});
