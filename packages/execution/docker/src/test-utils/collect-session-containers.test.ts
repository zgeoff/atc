import { expect, test } from 'bun:test';
import { collectSessionContainers } from './collect-session-containers';

test('it leaves out a throwaway container that Docker lists before the harness', () => {
  const names = ['atcplum-run-0f3a', 'atcplum-7c2e', 'atcplum-7c2e-relay'];

  expect(collectSessionContainers(names, 'atcplum-')).toStrictEqual({
    containers: ['atcplum-7c2e', 'atcplum-7c2e-relay'],
    harness: 'atcplum-7c2e',
  });
});

test('it finds no harness while only the relay sidecar runs', () => {
  expect(collectSessionContainers(['atcplum-7c2e-relay'], 'atcplum-')).toStrictEqual({
    containers: ['atcplum-7c2e-relay'],
    harness: undefined,
  });
});

test('it finds no containers once the session is forgotten', () => {
  expect(collectSessionContainers([], 'atcplum-')).toStrictEqual({
    containers: [],
    harness: undefined,
  });
});

test('it leaves out a container of another run whose name holds the prefix', () => {
  const names = ['other-atcplum-7c2e', 'atcplum-7c2e', 'atcplum-7c2e-relay'];

  expect(collectSessionContainers(names, 'atcplum-')).toStrictEqual({
    containers: ['atcplum-7c2e', 'atcplum-7c2e-relay'],
    harness: 'atcplum-7c2e',
  });
});
