import { expect, test } from 'bun:test';
import { buildClaudeOverrideArgs } from './build-claude-override-args';

test('it keeps the configured arguments as they stand when a spawn sets no override', () => {
  expect(
    buildClaudeOverrideArgs(['--model', 'opus', '--effort', 'low', '--verbose'], {}),
  ).toStrictEqual(['--model', 'opus', '--effort', 'low', '--verbose']);
});

test('it replaces a configured model and effort with the spawn overrides', () => {
  expect(
    buildClaudeOverrideArgs(['--model', 'opus', '--verbose', '--effort=low'], {
      model: 'sonnet[1m]',
      effort: 'max',
    }),
  ).toStrictEqual(['--verbose', '--model', 'sonnet[1m]', '--effort', 'max']);
});

test('it replaces only the option a spawn overrides', () => {
  expect(
    buildClaudeOverrideArgs(['--model', 'opus', '--effort', 'low'], { effort: 'high' }),
  ).toStrictEqual(['--model', 'opus', '--effort', 'high']);
});
