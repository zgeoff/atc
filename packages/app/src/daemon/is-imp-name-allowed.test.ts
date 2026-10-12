import { expect, test } from 'bun:test';
import { isImpNameAllowed } from './is-imp-name-allowed';

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
])('it matches patterns %p against imp %s as %p', (patterns, name, allowed) => {
  expect(isImpNameAllowed(patterns, name)).toBe(allowed);
});
