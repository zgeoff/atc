import { expect, test } from 'bun:test';
import { isProcessAlive } from './is-process-alive';

test('it reports this process as running', () => {
  expect(isProcessAlive(process.pid)).toBeTrue();
});

test('it reports a process that exited as not running', async () => {
  const child = Bun.spawn(['true']);

  await child.exited;

  expect(isProcessAlive(child.pid)).toBeFalse();
});

test('it reports a pid no process holds as not running', () => {
  expect(isProcessAlive(2 ** 22 + 12_345)).toBeFalse();
});
