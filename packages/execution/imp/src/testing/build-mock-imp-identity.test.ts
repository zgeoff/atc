import { expect, test } from 'bun:test';
import { buildMockImpIdentity } from './build-mock-imp-identity';

test('it builds a default imp identity', () => {
  expect(buildMockImpIdentity()).toStrictEqual({
    kind: 'token',
    name: expect.toBeString(),
    scope: 'manage',
    imps: ['atc-*'],
    grantable: [],
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(buildMockImpIdentity({ scope: 'read', imps: null, grantable: ['glm'] })).toStrictEqual({
    kind: 'token',
    name: expect.toBeString(),
    scope: 'read',
    imps: null,
    grantable: ['glm'],
  });
});
