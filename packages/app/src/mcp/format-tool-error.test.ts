import { expect, test } from 'bun:test';
import { DaemonError } from '@atc/protocol/wire';
import { formatToolError } from './format-tool-error';

test('it prefixes a daemon error with its code', () => {
  expect(formatToolError(new DaemonError('no_such_session', "no session 's1'"))).toBe(
    "no_such_session: no session 's1'",
  );
});

test('it prefixes any error that holds a lowercase protocol code', () => {
  const error = Object.assign(new Error('daemon d1 is offline'), { code: 'unreachable' });

  expect(formatToolError(error)).toBe('unreachable: daemon d1 is offline');
});

test('it shows a system error with an uppercase code as its message alone', () => {
  const error = Object.assign(new Error('connect ECONNREFUSED /run/atc.sock'), {
    code: 'ECONNREFUSED',
  });

  expect(formatToolError(error)).toBe('connect ECONNREFUSED /run/atc.sock');
});

test('it shows a value that is not an error as its string', () => {
  expect(formatToolError(42)).toBe('42');
});
