import { expect, test } from 'bun:test';
import { pickPTYPrincipal } from './pick-pty-principal';

test('it watches as the owner with a token from the owner token file', () => {
  expect(pickPTYPrincipal({ isOwnerToken: true, access: null })).toStrictEqual({
    kind: 'principal',
    principal: null,
  });
});

test('it watches as the client of an access token with the read scope', () => {
  expect(
    pickPTYPrincipal({
      isOwnerToken: false,
      access: { clientID: 'client-7c2e', clientName: 'viewer', scopes: ['read', 'message'] },
    }),
  ).toStrictEqual({ kind: 'principal', principal: 'client-7c2e' });
});

test.each([
  [
    'a token that verified to no access',
    401,
    { isOwnerToken: false, access: null },
    { kind: 'bearer', reason: 'invalid_token' },
  ],
  [
    'an access token with no scope',
    403,
    { isOwnerToken: false, access: { clientID: 'client-7c2e', clientName: 'viewer', scopes: [] } },
    null,
  ],
  [
    'an access token with every scope but read',
    403,
    {
      isOwnerToken: false,
      access: {
        clientID: 'client-7c2e',
        clientName: 'viewer',
        scopes: ['message', 'spawn', 'kill'],
      },
    },
    null,
  ],
  [
    'an access token for an empty client with only the message scope',
    403,
    { isOwnerToken: false, access: { clientID: '', clientName: '', scopes: ['message'] } },
    null,
  ],
] as const)('it refuses %s with %d', (_label, status, check, outcome) => {
  expect(pickPTYPrincipal(check)).toStrictEqual({ kind: 'refuse', status, outcome });
});
