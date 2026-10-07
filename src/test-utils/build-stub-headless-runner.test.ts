import { expect, mock, test } from 'bun:test';
import { buildStubHeadlessRunner } from './build-stub-headless-runner';

test('it records the request and hooks it was called with', () => {
  const runner = buildStubHeadlessRunner();
  const hooks = { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} };

  runner({ cwd: '/work', prompt: 'go', claudeBin: 'claude' }, hooks);

  expect(runner).toHaveBeenCalledExactlyOnceWith(
    { cwd: '/work', prompt: 'go', claudeBin: 'claude' },
    hooks,
  );
});

test('it fires none of the event hooks', () => {
  const runner = buildStubHeadlessRunner();
  const onOutput = mock(() => {});
  const onDone = mock(() => {});
  const onNeedsYou = mock(() => {});

  runner({ cwd: '/work', prompt: 'go', claudeBin: 'claude' }, { onOutput, onDone, onNeedsYou });

  expect([onOutput.mock.calls, onDone.mock.calls, onNeedsYou.mock.calls]).toStrictEqual([
    [],
    [],
    [],
  ]);
});

test('it returns a handle whose stop returns without throwing', () => {
  const runner = buildStubHeadlessRunner();

  const handle = runner(
    { cwd: '/work', prompt: 'go', claudeBin: 'claude' },
    { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} },
  );

  expect(() => {
    handle.stop();
  }).not.toThrow();
});
