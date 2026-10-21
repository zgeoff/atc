import { expect, test } from 'bun:test';
import { buildPageResponse } from './build-page-response';

test('it sends the referrer only to its own origin so a form post keeps its Origin header', () => {
  const response = buildPageResponse(200, { message: 'hello' });

  expect(response.headers.get('referrer-policy')).toBe('same-origin');
});

test('it allows no script when it is given no script source', () => {
  const response = buildPageResponse(200, { message: 'hello' });

  expect(response.headers.get('content-security-policy')).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
});

test('it allows only the script sources it is given', () => {
  const response = buildPageResponse(200, { message: 'hello' }, [], ["'sha256-abc'"]);

  expect(response.headers.get('content-security-policy')).toBe(
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-abc'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
});
