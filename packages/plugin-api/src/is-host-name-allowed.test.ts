import { expect, test } from 'bun:test';
import { isHostNameAllowed } from './is-host-name-allowed';

test.each([
  [['atc-*'], 'atc-s1', true],
  [['atc-*'], 'atc-', true],
  [['atc-*'], 'harness-s1', false],
  [['atc-*'], 'xatc-s1', false],
  [['harness-*'], 'harness-s1', true],
  [['atc-s1'], 'atc-s1', true],
  [['atc-s1'], 'atc-s10', false],
  [['*-s1'], 'atc-s1', true],
  [['a*c*1'], 'atc-s1', true],
  [['a*c*1'], 'abc', false],
  [['ab*ba'], 'aba', false],
  [['dev-*', 'atc-*'], 'atc-s1', true],
  [[], 'atc-s1', false],
])('it matches patterns %p against host %s as %p', (patterns, name, allowed) => {
  expect(isHostNameAllowed(patterns, name)).toBe(allowed);
});
