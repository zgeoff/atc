import { expect, test } from 'bun:test';
import { LocalPTYProvider } from '../daemon/local-pty-provider';
import { buildMockExecutionTarget } from './build-mock-execution-target';

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
  const provider = new LocalPTYProvider();

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
  const provider = new LocalPTYProvider();

  expect(buildMockExecutionTarget({ provider }).provider).toBe(provider);
});
