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

test('it refuses a token that verified to no access', () => {
  expect(pickPTYPrincipal({ isOwnerToken: false, access: null })).toStrictEqual({
    kind: 'refused',
  });
});

test.each([
  ['no scope', []],
  ['the message and spawn scopes', ['message', 'spawn']],
] as const)('it refuses an access token with %s as one that may not read', (_label, scopes) => {
  expect(
    pickPTYPrincipal({
      isOwnerToken: false,
      access: { clientID: 'client-7c2e', clientName: 'viewer', scopes },
    }),
  ).toStrictEqual({ kind: 'no_read' });
});
