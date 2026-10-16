import { expect, test } from 'bun:test';
import { SessionInputQueue } from './session-input-queue';

test('it runs a task scheduled on an idle queue before the call returns', () => {
  const queue = new SessionInputQueue();

  const written: string[] = [];

  queue.schedule(() => {
    written.push('line');
  });

  expect(written).toStrictEqual(['line']);
});

test('it holds a task scheduled while an earlier task awaits until that task settles', async () => {
  const queue = new SessionInputQueue();

  const written: string[] = [];
  const pause = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();

  queue.schedule(async () => {
    written.push('name');

    await pause.promise;

    written.push('argument');
  });

  queue.schedule(() => {
    written.push('other input');
    done.resolve();
  });

  const heldBack = [...written];

  pause.resolve();

  await done.promise;

  expect(heldBack).toStrictEqual(['name']);
  expect(written).toStrictEqual(['name', 'argument', 'other input']);
});

test('it runs the tasks behind a task that throws', async () => {
  const queue = new SessionInputQueue();

  const done = Promise.withResolvers<string>();

  queue.schedule(() => {
    throw new Error('write failed');
  });

  queue.schedule(() => {
    done.resolve('next');
  });

  const ran = await done.promise;

  expect(ran).toBe('next');
});

test('it runs the tasks behind a task that rejects', async () => {
  const queue = new SessionInputQueue();

  const done = Promise.withResolvers<string>();

  queue.schedule(() => Promise.reject(new Error('write failed')));

  queue.schedule(() => {
    done.resolve('next');
  });

  const ran = await done.promise;

  expect(ran).toBe('next');
});
