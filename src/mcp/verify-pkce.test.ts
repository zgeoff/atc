import { expect, test } from 'bun:test';
import { verifyPKCE } from './verify-pkce';

test('it accepts the verifier from the RFC 7636 example', () => {
  expect(
    verifyPKCE(
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    ),
  ).toBeTrue();
});

test('it refuses a verifier that does not match the challenge', () => {
  expect(verifyPKCE('wrong-verifier', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBeFalse();
});
