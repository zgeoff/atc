import { expect, mock, test } from 'bun:test';
import { buildStubClaudeHeadlessRun } from './build-stub-claude-headless-run';

test('it fires none of the event hooks', () => {
  const runner = buildStubClaudeHeadlessRun();
  const onOutput = mock(() => {});
  const onDone = mock(() => {});
  const onNeedsYou = mock(() => {});

  runner({ cwd: '/work', prompt: 'go', claudeBin: 'claude' }, { onOutput, onDone, onNeedsYou });

  expect(onOutput).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
  expect(onNeedsYou).not.toHaveBeenCalled();
});

test('it returns a handle whose stop returns without throwing', () => {
  const runner = buildStubClaudeHeadlessRun();

  const handle = runner(
    { cwd: '/work', prompt: 'go', claudeBin: 'claude' },
    { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} },
  );

  expect(() => {
    handle.stop();
  }).not.toThrow();
});
