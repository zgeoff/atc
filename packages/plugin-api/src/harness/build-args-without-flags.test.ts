import { expect, test } from 'bun:test';
import { buildArgsWithoutFlags } from './build-args-without-flags';

test('it removes each named flag with its value and keeps every other argument in place', () => {
  expect(
    buildArgsWithoutFlags(
      ['--verbose', '--model', 'opus', '--add-dir', '/x', '--effort=high'],
      ['--model', '--effort'],
    ),
  ).toStrictEqual(['--verbose', '--add-dir', '/x']);
});

test('it removes every occurrence of a repeated flag', () => {
  expect(
    buildArgsWithoutFlags(['-m', 'a', '--model', 'b', '-m', 'c'], ['-m', '--model']),
  ).toStrictEqual([]);
});

test('it leaves the list as it stands when no flag is named', () => {
  expect(buildArgsWithoutFlags(['--model', 'opus'], [])).toStrictEqual(['--model', 'opus']);
});
