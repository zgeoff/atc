import { expect, onTestFinished, test } from 'bun:test';
import { buildMockHostServices } from '@atc/test-utils/build-mock-host-services';
import invariant from 'tiny-invariant';
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
    buildMockHostServices({ version: '1.0.0' }),
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
    buildMockHostServices({ version: '1.0.0' }),
    { ATC_TEST_IMP_TOKEN: 'token-value' },
  );

  expect(built.errors).toStrictEqual([]);
});

test('it gives an imp target another identity when its token file path changes', () => {
  const built = buildExecutionTargets(
    [
      {
        id: 'a',
        provider: 'imp',
        options: { url: 'http://127.0.0.1:9', tokenFile: '/run/credentials/one/imp-token' },
      },
      {
        id: 'b',
        provider: 'imp',
        options: { url: 'http://127.0.0.1:9', tokenFile: '/run/credentials/two/imp-token' },
      },
    ],
    buildMockHostServices({ version: '1.0.0' }),
    {},
  );

  const [first, second] = built.targets;

  invariant(first !== undefined && second !== undefined, 'expected two targets');

  expect(first.identity).not.toBe(second.identity);
});

test('it builds the identities a daemon stored before the providers moved into packages', () => {
  const built = buildExecutionTargets(
    [
      { id: 'local', provider: 'local-pty', options: {} },
      {
        id: 'cloud',
        provider: 'imp',
        options: {
          url: 'http://impd.example:7070',
          tokenEnv: 'FIXTURE_IMP_TOKEN',
          image: 'atc-base',
        },
      },
    ],
    buildMockHostServices({ version: '1.0.0' }),
    { FIXTURE_IMP_TOKEN: 'fixture-token' },
  );

  onTestFinished(() => Promise.all(built.targets.map((target) => target.provider?.dispose())));

  // fleet rows hold these identities, so no change to where a provider's
  // code lives may move them while the target config stays the same
  expect(
    built.targets.map((target) => [target.id, target.identity, target.provider?.kind]),
  ).toStrictEqual([
    ['local', 'local-pty:44136fa355b3678a', 'local-pty'],
    ['cloud', 'imp:reach-v1:c97f60aac21db24e', 'imp'],
  ]);
});
