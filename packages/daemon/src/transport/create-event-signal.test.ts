import { expect, test } from 'bun:test';
import { buildStubClock } from '@atc/test-utils';
import { createEventSignal } from './create-event-signal';

test('it resolves a wait at once when an event landed since the reader looked', async () => {
  const clock = buildStubClock(0);
  const signal = createEventSignal(clock);
  const generation = signal.generation;

  signal.emit();

  // The clock never moves, so only a wait that holds no timer resolves.
  await expect(signal.waitForNext(generation, 10_000)).toResolve();
});

test('it resolves a pending wait when an event is emitted', async () => {
  const clock = buildStubClock(0);
  const signal = createEventSignal(clock);
  const pending = signal.waitForNext(signal.generation, 10_000);

  signal.emit();

  await expect(pending).toResolve();
});

test('it ends the timer of a wait an event resolves', async () => {
  const clock = buildStubClock(0);
  const signal = createEventSignal(clock);
  const pending = signal.waitForNext(signal.generation, 10_000);

  signal.emit();

  await pending;

  expect(clock.collectPending()).toStrictEqual([]);
});

test('it holds a wait with no event on a timer of its timeout', () => {
  const clock = buildStubClock(0);
  const signal = createEventSignal(clock);
  const waiting = signal.waitForNext(signal.generation, 100);

  expect(clock.collectPending()).toStrictEqual([100]);
  expect(Bun.peek.status(waiting)).toBe('pending');
});

test('it resolves a wait with no event once the timeout passes', async () => {
  const clock = buildStubClock(0);
  const signal = createEventSignal(clock);
  const pending = signal.waitForNext(signal.generation, 100);

  clock.advance(100);

  await expect(pending).toResolve();
});

test('it resolves pending waits on dispose', async () => {
  const clock = buildStubClock(0);
  const signal = createEventSignal(clock);
  const pending = signal.waitForNext(signal.generation, 10_000);

  signal.dispose();

  await expect(pending).toResolve();
});

test('it resolves every wait after dispose at once', async () => {
  const clock = buildStubClock(0);
  const signal = createEventSignal(clock);

  signal.dispose();

  await expect(signal.waitForNext(signal.generation, 10_000)).toResolve();
});

test('it counts each wait still pending', () => {
  const signal = createEventSignal(buildStubClock(0));

  const waits = [
    signal.waitForNext(signal.generation, 10_000),
    signal.waitForNext(signal.generation, 10_000),
  ];

  expect(signal.countWaiters()).toBe(2);
  expect(waits.map((wait) => Bun.peek.status(wait))).toStrictEqual(['pending', 'pending']);
});

test('it counts no wait once an event wakes every pending one', () => {
  const signal = createEventSignal(buildStubClock(0));

  const waits = [
    signal.waitForNext(signal.generation, 10_000),
    signal.waitForNext(signal.generation, 10_000),
  ];

  signal.emit();

  expect(signal.countWaiters()).toBe(0);
  expect(waits.map((wait) => Bun.peek.status(wait))).toStrictEqual(['fulfilled', 'fulfilled']);
});

test('it counts no wait that resolved at once', () => {
  const signal = createEventSignal(buildStubClock(0));
  const generation = signal.generation;

  signal.emit();

  const wait = signal.waitForNext(generation, 10_000);

  expect(signal.countWaiters()).toBe(0);
  expect(Bun.peek.status(wait)).toBe('fulfilled');
});
