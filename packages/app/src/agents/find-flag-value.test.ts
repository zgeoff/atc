import { expect, test } from 'bun:test';
import { findFlagValue } from './find-flag-value';

test('it reads a flag written apart from its value', () => {
  expect(findFlagValue(['--verbose', '--model', 'opus'], ['--model'])).toBe('opus');
});

test('it reads a flag written with an equals sign', () => {
  expect(findFlagValue(['--model=sonnet'], ['--model'])).toBe('sonnet');
});

test('it reads the last occurrence when the flag repeats', () => {
  expect(findFlagValue(['-m', 'gpt-a', '--model', 'gpt-b'], ['-m', '--model'])).toBe('gpt-b');
});

test('it finds nothing when the list never sets the flag', () => {
  expect(findFlagValue(['--verbose', '--effort', 'high'], ['--model'])).toBeNull();
});

test('it finds nothing for a trailing flag with no value', () => {
  expect(findFlagValue(['--model'], ['--model'])).toBeNull();
});
