import { expect, test } from 'bun:test';
import { buildTargetIdentity } from './build-target-identity';

test('it builds the provider kind and a sixteen-digit hex digest of the options', () => {
  expect(buildTargetIdentity('imp', { image: 'dev' })).toMatch(/^imp:[\da-f]{16}$/);
});

test('it builds the same identity whatever order the options list their keys in', () => {
  expect(buildTargetIdentity('imp', { image: 'dev', size: { cpu: 2, ram: 4 } })).toBe(
    buildTargetIdentity('imp', { size: { ram: 4, cpu: 2 }, image: 'dev' }),
  );
});

test('it builds another identity for another provider kind with the same options', () => {
  expect(buildTargetIdentity('imp', { image: 'dev' })).not.toBe(
    buildTargetIdentity('local-pty', { image: 'dev' }),
  );
});

test('it builds another identity for other options under the same provider kind', () => {
  expect(buildTargetIdentity('imp', { image: 'dev' })).not.toBe(
    buildTargetIdentity('imp', { image: 'ci' }),
  );
});

test.each([
  ['unset', {}],
  ['false', { trustClonedWorkspace: false }],
])('it changes target identity when clone trust changes from %s to true', (_previous, options) => {
  expect(buildTargetIdentity('imp', { trustClonedWorkspace: true })).not.toBe(
    buildTargetIdentity('imp', options),
  );
});
