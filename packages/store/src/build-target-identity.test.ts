import { expect, test } from 'bun:test';
import { buildTargetIdentity } from './build-target-identity';

test('it builds the identity a stored session holds for the same options', () => {
  expect(buildTargetIdentity('ssh', { Host: 'b', host: 'a', port: 22 })).toBe(
    'ssh:701fa2ef7016a7cb',
  );
});

test('it writes the version a rule declares between the kind and the digest', () => {
  expect(
    buildTargetIdentity('cloud', { region: 'north' }, { version: 'reach-v3', ignoredOptions: [] }),
  ).toMatch(/^cloud:reach-v3:[\da-f]{16}$/u);
});

test('it builds the same identity whatever order the options list their keys in', () => {
  expect(buildTargetIdentity('cloud', { image: 'dev', size: { cpu: 2, ram: 4 } })).toBe(
    buildTargetIdentity('cloud', { size: { ram: 4, cpu: 2 }, image: 'dev' }),
  );
});

test('it builds another identity for another provider kind with the same options', () => {
  expect(buildTargetIdentity('cloud', { image: 'dev' })).not.toBe(
    buildTargetIdentity('local-pty', { image: 'dev' }),
  );
});

test('it preserves the identity when an option the rule ignores changes', () => {
  expect(
    buildTargetIdentity(
      'cloud',
      { region: 'north', image: 'dev' },
      { version: 'reach-v3', ignoredOptions: ['image'] },
    ),
  ).toBe(
    buildTargetIdentity(
      'cloud',
      { region: 'north', image: 'ci' },
      { version: 'reach-v3', ignoredOptions: ['image'] },
    ),
  );
});

test('it builds another identity when an option the rule does not ignore changes', () => {
  expect(
    buildTargetIdentity(
      'cloud',
      { region: 'north', image: 'dev' },
      { version: 'reach-v3', ignoredOptions: ['image'] },
    ),
  ).not.toBe(
    buildTargetIdentity(
      'cloud',
      { region: 'south', image: 'dev' },
      { version: 'reach-v3', ignoredOptions: ['image'] },
    ),
  );
});

test('it builds another identity for an option change on a kind that declares no rule', () => {
  expect(buildTargetIdentity('cloud', { image: 'dev' })).not.toBe(
    buildTargetIdentity('cloud', { image: 'ci' }),
  );
});
