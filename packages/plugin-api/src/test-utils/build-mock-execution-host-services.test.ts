import { expect, test } from 'bun:test';
import { buildMockExecutionHostServices } from './build-mock-execution-host-services';

test('it builds host services with the state folder and the version it is given', () => {
  const host = buildMockExecutionHostServices({
    stateDir: '/state/providers/box',
    version: '2.0.0',
  });

  expect(host.stateDir).toBe('/state/providers/box');
  expect(host.version).toBe('2.0.0');
});

test('it builds a state folder when it is given none', () => {
  expect(buildMockExecutionHostServices().stateDir).toBeString();
});
