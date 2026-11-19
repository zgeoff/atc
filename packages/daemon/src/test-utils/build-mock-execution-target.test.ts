import { expect, test } from 'bun:test';
import { buildMockExecutionTarget } from './build-mock-execution-target';
import { buildStubMemoryProvider } from './build-stub-memory-provider';

test('it builds a default execution target', () => {
  expect(buildMockExecutionTarget()).toStrictEqual({
    id: expect.toBeString(),
    kind: 'local-pty',
    options: {},
    identity: expect.toStartWith('local-pty:'),
    provider: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  expect(
    buildMockExecutionTarget({
      id: 'box',
      kind: 'imp',
      options: { image: 'base' },
      identity: 'imp:test',
      provider,
    }),
  ).toStrictEqual({
    id: 'box',
    kind: 'imp',
    options: { image: 'base' },
    identity: 'imp:test',
    provider,
  });
});

test('it keeps a provider override as the same instance', () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  expect(buildMockExecutionTarget({ provider }).provider).toBe(provider);
});
