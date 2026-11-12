import { expect, test } from 'bun:test';
import { DaemonError } from '@atc/protocol/wire';
import { buildToolErrorContent } from './build-tool-error-content';

test('it gives the code and the problem of a daemon error that names one', () => {
  const error = new DaemonError('unsupported_operation', 'no room', {
    problem: 'ram_budget_exceeded',
  });

  expect(buildToolErrorContent(error)).toStrictEqual({
    code: 'unsupported_operation',
    problem: 'ram_budget_exceeded',
  });
});

test('it passes no data field other than the problem', () => {
  const error = new DaemonError('unsupported_operation', 'no room', {
    problem: 'host_asleep',
    session: 'harbor/s-9',
    target: 'lantern-west',
    effectRef: 'e-1',
  });

  expect(buildToolErrorContent(error)).toStrictEqual({
    code: 'unsupported_operation',
    problem: 'host_asleep',
  });
});

test('it gives the code alone for an error whose data holds no problem', () => {
  const error = new DaemonError('no_such_session', 'no session', {
    session: 'harbor/s-9',
  });

  expect(buildToolErrorContent(error)).toStrictEqual({
    code: 'no_such_session',
  });
});

test('it gives the code alone for an error with no data', () => {
  expect(buildToolErrorContent(new DaemonError('bad_args', 'bad'))).toStrictEqual({
    code: 'bad_args',
  });
});

test('it gives the code alone when the problem is not a string', () => {
  const error = new DaemonError('bad_args', 'bad', { problem: 7 });

  expect(buildToolErrorContent(error)).toStrictEqual({ code: 'bad_args' });
});

test('it reads the code of the error a refusal wraps', () => {
  const error = new Error('session_live: stop it', {
    cause: new DaemonError('session_live', 'live'),
  });

  expect(buildToolErrorContent(error)).toStrictEqual({ code: 'session_live' });
});

test.each([
  ['a plain error', new Error('boom')],
  ['a system error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })],
  ['a value that is not an error', 'boom'],
])('it gives nothing for %s', (_name, error) => {
  expect(buildToolErrorContent(error)).toBeNull();
});
