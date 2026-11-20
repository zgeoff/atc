import { expect, test } from 'bun:test';
import { isBreakingMarked } from './is-breaking-marked';

test.each([
  ['a type with a bang', 'feat!: drop the old field'],
  ['a scoped type with a bang', 'fix(contract)!: rename a procedure'],
  ['a footer', 'feat: add a field\n\nBREAKING CHANGE: the field replaces another'],
  ['a hyphenated footer', 'feat: add a field\n\nBREAKING-CHANGE: the field replaces another'],
])('it marks a message with %s as breaking', (_label, message) => {
  expect(isBreakingMarked(['docs: fix a typo', message])).toBeTrue();
});

test.each([
  ['a plain feature', 'feat: add a field'],
  ['a bang inside the body', 'feat: add a field\n\nthis is not a fix!: really'],
  ['no message', ''],
])('it does not mark %s as breaking', (_label, message) => {
  expect(isBreakingMarked([message])).toBeFalse();
});
