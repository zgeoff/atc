import { expect, test } from 'bun:test';
import { buildTargetIdentity } from './build-target-identity';

test('it builds a versioned imp identity with a sixteen-digit hex digest', () => {
  expect(buildTargetIdentity('imp', { image: 'dev' })).toMatch(/^imp:reach-v1:[\da-f]{16}$/);
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

test('it preserves the identity when the image for new imps changes', () => {
  expect(buildTargetIdentity('imp', { image: 'dev' })).toBe(
    buildTargetIdentity('imp', { image: 'ci' }),
  );
});

test.each([
  ['guestATC', '/usr/bin/atc', '/opt/atc'],
  ['memoryMib', 2048, 4096],
])('it preserves the identity when %s changes', (key, before, after) => {
  expect(buildTargetIdentity('imp', { [key]: before })).toBe(
    buildTargetIdentity('imp', { [key]: after }),
  );
});

test.each([
  ['url', 'http://server-a', 'http://server-b'],
  ['tokenEnv', 'TOKEN_A', 'TOKEN_B'],
  ['tokenFile', '/tokens/a', '/tokens/b'],
  ['impPrefix', 'home-', 'work-'],
  ['guestDir', '/tmp/atc', '/opt/atc'],
])('it refuses a changed %s through a different identity', (key, before, after) => {
  expect(buildTargetIdentity('imp', { [key]: before })).not.toBe(
    buildTargetIdentity('imp', { [key]: after }),
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
