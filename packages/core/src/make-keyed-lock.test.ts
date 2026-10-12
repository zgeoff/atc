import { expect, test } from 'bun:test';
import { makeKeyedLock } from './make-keyed-lock';

test('it runs a call with a key after the earlier call with that key settles', async () => {
  const withLock = makeKeyedLock<string>();
  const order: string[] = [];
  const first = Promise.withResolvers<void>();

  const running = withLock('a', async () => {
    await first.promise;

    order.push('first');
  });

  const queued = withLock('a', () => Promise.resolve(order.push('second')));

  first.resolve();

  await Promise.all([running, queued]);

  expect(order).toStrictEqual(['first', 'second']);
});

test('it runs calls with different keys at once', async () => {
  const withLock = makeKeyedLock<string>();
  const order: string[] = [];
  const first = Promise.withResolvers<void>();

  const running = withLock('a', async () => {
    await first.promise;

    order.push('a');
  });

  await withLock('b', () => Promise.resolve(order.push('b')));

  first.resolve();

  await running;

  expect(order).toStrictEqual(['b', 'a']);
});

test('it releases the key when a call throws', async () => {
  const withLock = makeKeyedLock<string>();
  const failed = withLock('a', () => Promise.reject(new Error('boom')));
  const next = withLock('a', () => Promise.resolve('ran'));

  expect(failed).rejects.toThrow('boom');

  const ran = await next;

  expect(ran).toBe('ran');
});

test('it returns the value of the call it runs', async () => {
  const withLock = makeKeyedLock<string>();

  const value = await withLock('a', () => Promise.resolve(42));

  expect(value).toBe(42);
});
