import { expect, test } from 'bun:test';
import { buildServiceClientID } from './build-service-client-id';
import { buildServiceTokenVerifier } from './build-service-token-verifier';
import { isServiceClientID } from './is-service-client-id';

function setupTest() {
  return {
    verifier: buildServiceTokenVerifier({
      resource: 'https://atc.example.com/mcp',
      clients: [
        {
          name: 'ci-bot',
          scopes: ['read', 'message'],
          tokens: [`atcs_${'a'.repeat(32)}`, `atcs_${'b'.repeat(32)}`],
        },
        { name: 'watcher', scopes: ['read'], tokens: [`atcs_${'c'.repeat(32)}`] },
      ],
    }),
  };
}

test.each([[`atcs_${'a'.repeat(32)}`], [`atcs_${'b'.repeat(32)}`]])(
  'it gives the access of a client during a rotation to token %p',
  (token) => {
    const ctx = setupTest();

    expect(ctx.verifier.verify(token)).toStrictEqual({
      clientID: 'service:ci-bot',
      clientName: 'service:ci-bot',
      scopes: ['read', 'message'],
    });
  },
);

test('it gives the scopes of the client that holds the token', () => {
  const ctx = setupTest();

  expect(ctx.verifier.verify(`atcs_${'c'.repeat(32)}`)).toStrictEqual({
    clientID: 'service:watcher',
    clientName: 'service:watcher',
    scopes: ['read'],
  });
});

test.each([
  [''],
  ['atcs_'],
  [`atcs_${'d'.repeat(32)}`],
  [`atcs_${'a'.repeat(32)}`.slice(0, -1)],
  [`${`atcs_${'a'.repeat(32)}`}x`],
])('it gives no access to the token %p', (token) => {
  const ctx = setupTest();

  expect(ctx.verifier.verify(token)).toBeNull();
});

test('it finds the scopes of a listed service client', () => {
  const ctx = setupTest();

  expect(ctx.verifier.findScopes('service:ci-bot')).toStrictEqual(['read', 'message']);
});

test('it finds no scopes for an unlisted ID', () => {
  const ctx = setupTest();

  expect(ctx.verifier.findScopes('service:gone')).toBeNull();
});

test('it builds a service client ID that no OAuth client ID can equal', () => {
  const oauthClientID = /^[A-Za-z0-9]{32}$/u;
  const serviceID = buildServiceClientID('ci-bot');

  expect(isServiceClientID(serviceID)).toBeTrue();
  expect(serviceID).not.toMatch(oauthClientID);
});
