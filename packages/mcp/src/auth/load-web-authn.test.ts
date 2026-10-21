import { expect, test } from 'bun:test';
import { loadWebAuthn } from './load-web-authn';

test('it loads the verifiers with the Reflect metadata polyfill in place', async () => {
  const webAuthn = await loadWebAuthn();

  expect(Object.hasOwn(Reflect, 'getMetadata')).toBe(true);
  expect(webAuthn.verifyAuthenticationResponse).toBeFunction();
  expect(webAuthn.verifyRegistrationResponse).toBeFunction();
});
