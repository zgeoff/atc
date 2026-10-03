import { expect, test } from 'bun:test';
import { buildExecutionTargets } from './build-execution-targets';

test('it reports an imp target whose token variable is unset as a target error, and keeps it listed', () => {
  const built = buildExecutionTargets(
    [
      { id: 'local', provider: 'local-pty', options: {} },
      {
        id: 'box',
        provider: 'imp',
        options: { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN' },
      },
    ],
    {},
  );

  expect(built.targets.map((target) => [target.id, target.provider === null])).toStrictEqual([
    ['local', false],
    ['box', true],
  ]);

  expect(built.errors).toStrictEqual([
    {
      scope: 'target',
      target: 'box',
      problem:
        'target "box" reads its impd token from ATC_TEST_IMP_TOKEN, which is unset or empty in the daemon\'s environment',
    },
  ]);
});

test('it reports no target error for an imp target whose token variable is set', () => {
  const built = buildExecutionTargets(
    [
      {
        id: 'box',
        provider: 'imp',
        options: { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN' },
      },
    ],
    { ATC_TEST_IMP_TOKEN: 'token-value' },
  );

  expect(built.errors).toStrictEqual([]);
});
