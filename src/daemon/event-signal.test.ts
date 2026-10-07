import { expect, onTestFinished, test } from 'bun:test';
import { EventSignal } from './event-signal';

test('it resolves a wait at once when an event landed since the reader looked', async () => {
  const signal = new EventSignal();

  const generation = signal.generation;

  signal.emit();

  const start = Date.now();

  await expect(signal.waitForNext(generation, 10_000)).toResolve();

  expect(Date.now()).toBeWithin(start, start + 1000);
});

test('it resolves a pending wait when an event is emitted', async () => {
  const signal = new EventSignal();

  const start = Date.now();
  const pending = signal.waitForNext(signal.generation, 10_000);

  signal.emit();

  await expect(pending).toResolve();

  expect(Date.now()).toBeWithin(start, start + 1000);
});

test('it resolves a wait with no event once the timeout passes', async () => {
  const signal = new EventSignal();

  const start = Date.now();

  await signal.waitForNext(signal.generation, 100);

  expect(Date.now()).toBeWithin(start + 90, start + 2000);
});

test('it resolves pending waits on dispose and every later wait at once', async () => {
  const signal = new EventSignal();

  const start = Date.now();
  const pending = signal.waitForNext(signal.generation, 10_000);

  signal.dispose();

  await expect(pending).toResolve();
  await expect(signal.waitForNext(signal.generation, 10_000)).toResolve();

  expect(Date.now()).toBeWithin(start, start + 1000);
});

test('it counts each wait still pending', () => {
  const signal = new EventSignal();

  onTestFinished(() => {
    signal.dispose();
  });

  void signal.waitForNext(signal.generation, 10_000);
  void signal.waitForNext(signal.generation, 10_000);
  expect(signal.countWaiters()).toBe(2);
});

test('it counts no wait once an event wakes every pending one', () => {
  const signal = new EventSignal();

  void signal.waitForNext(signal.generation, 10_000);
  void signal.waitForNext(signal.generation, 10_000);
  signal.emit();

  expect(signal.countWaiters()).toBe(0);
});

test('it counts no wait that resolved at once', () => {
  const signal = new EventSignal();

  const generation = signal.generation;

  signal.emit();
  void signal.waitForNext(generation, 10_000);
  expect(signal.countWaiters()).toBe(0);
});
