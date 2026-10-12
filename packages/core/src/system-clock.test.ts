import { expect, test } from 'bun:test';
import { systemClock } from './system-clock';

test('it reads the wall clock', () => {
  const before = Date.now();
  const now = systemClock.now();

  expect(now).toBeWithin(before, Date.now() + 1);
});

test('it runs a scheduled callback once its delay passes', async () => {
  const ran = Promise.withResolvers<'ran'>();

  systemClock.schedule(() => {
    ran.resolve('ran');
  }, 0);

  const result = await ran.promise;

  expect(result).toBe('ran');
});

test('it never runs a callback cancelled before its delay passes', async () => {
  const calls: string[] = [];
  const later = Promise.withResolvers<void>();

  const cancel = systemClock.schedule(() => {
    calls.push('cancelled');
  }, 0);

  systemClock.schedule(later.resolve, 0);

  cancel();

  await later.promise;

  expect(calls).toBeEmpty();
});
