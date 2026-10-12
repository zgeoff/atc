import { expect, test } from 'bun:test';
import { TargetUnavailableError } from './target-unavailable-error';

test('it holds the problem that keeps the target from a provider as its message', () => {
  const error = new TargetUnavailableError('box', 'the token file is empty');

  expect(error.problem).toBe('the token file is empty');
  expect(error.message).toBe('the token file is empty');
});

test('it holds no problem for a target left unconfigured, and says so in its message', () => {
  const error = new TargetUnavailableError('box', null);

  expect(error.problem).toBeNull();
  expect(error.message).toBe('target "box" has no provider configured');
});
