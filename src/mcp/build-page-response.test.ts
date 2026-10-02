import { expect, test } from 'bun:test';
import { buildPageResponse } from './build-page-response';

test('it sends the referrer only to its own origin so a form post keeps its Origin header', () => {
  const response = buildPageResponse(200, { message: 'hello' });

  expect(response.headers.get('referrer-policy')).toBe('same-origin');
});
