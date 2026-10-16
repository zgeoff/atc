import { expect, test } from 'bun:test';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { buildExecutionTargets } from './build-execution-targets';

test('it builds one target per entry, in config order, each with the provider built for it', () => {
  const local = buildStubMemoryProvider({ kind: 'local-pty' });

  const built = buildExecutionTargets(
    [
      { id: 'local', provider: 'local-pty', options: {} },
      { id: 'far', provider: 'teleport', options: {} },
    ],
    (config) => ({ provider: config.id === 'local' ? local : null, problem: null }),
  );

  expect(built.targets.map((target) => [target.id, target.kind, target.provider])).toStrictEqual([
    ['local', 'local-pty', local],
    ['far', 'teleport', null],
  ]);

  expect(built.errors).toStrictEqual([]);
});

test('it records a target error for an entry whose provider reports a problem, and keeps it listed', () => {
  const built = buildExecutionTargets(
    [{ id: 'box', provider: 'imp', options: { url: 'http://127.0.0.1:9' } }],
    () => ({ provider: null, problem: 'target "box" cannot reach its impd' }),
  );

  expect(built.targets.map((target) => target.id)).toStrictEqual(['box']);

  expect(built.errors).toStrictEqual([
    { scope: 'target', target: 'box', problem: 'target "box" cannot reach its impd' },
  ]);
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
    () => ({ provider: null, problem: null }),
  );

  expect(built.targets[0]?.identity).not.toBe(built.targets[1]?.identity);
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
    () => ({ provider: null, problem: null }),
  );

  // fleet rows hold these identities, so no change to where a provider's
  // code lives may move them while the target config stays the same
  expect(built.targets.map((target) => [target.id, target.identity])).toStrictEqual([
    ['local', 'local-pty:44136fa355b3678a'],
    ['cloud', 'imp:reach-v1:c97f60aac21db24e'],
  ]);
});
