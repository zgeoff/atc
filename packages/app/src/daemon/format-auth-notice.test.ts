import { expect, test } from 'bun:test';
import { formatAuthNotice } from './format-auth-notice';

test('it says the auth revision applies at the next launch', () => {
  expect(formatAuthNotice(3)).toBe('auth revision 3 applies at the next launch');
});
