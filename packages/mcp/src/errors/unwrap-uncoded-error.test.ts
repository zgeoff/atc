import { expect, test } from 'bun:test';
import { AtcError } from '@atcx/contract/light';
import { unwrapUncodedError } from './unwrap-uncoded-error';

test('it gives back the caller error that the router wrapped as internal', () => {
  const cause = new Error('daemon connection closed');

  const wrapped = Object.assign(new Error('failed', { cause }), { code: 'internal' });

  expect(unwrapUncodedError(wrapped)).toBe(cause);
});

test('it gives back the string a caller rejected with, which the router wrapped as internal', () => {
  const wrapped = Object.assign(
    new Error('daemon connection closed', { cause: 'daemon connection closed' }),
    {
      code: 'internal',
    },
  );

  expect(unwrapUncodedError(wrapped)).toBe('daemon connection closed');
});

test('it keeps an internal error whose cause holds a code', () => {
  const cause = new AtcError('internal', 'the daemon failed');

  const wrapped = Object.assign(new Error('failed', { cause }), { code: 'internal' });

  expect(unwrapUncodedError(wrapped)).toBe(wrapped);
});

test('it keeps an internal error with no cause', () => {
  const error = Object.assign(new Error('failed'), { code: 'internal' });

  expect(unwrapUncodedError(error)).toBe(error);
});

test('it keeps an error of another code', () => {
  const error = Object.assign(new Error('failed', { cause: new Error('gone') }), {
    code: 'no_such_session',
  });

  expect(unwrapUncodedError(error)).toBe(error);
});
