import { expect, test } from 'bun:test';
import { buildStubClock } from './build-stub-clock';

test('it reads the time it starts at', () => {
  expect(buildStubClock(1000).now()).toBe(1000);
});

test('it moves the time by the step it advances', () => {
  const clock = buildStubClock(1000);

  clock.advance(250);

  expect(clock.now()).toBe(1250);
});

test('it runs no callback before its delay passes', () => {
  const clock = buildStubClock(0);
  const calls: number[] = [];

  clock.schedule(() => {
    calls.push(clock.now());
  }, 100);

  clock.advance(99);

  expect(calls).toBeEmpty();
});

test('it runs due callbacks in due order at their due time', () => {
  const clock = buildStubClock(0);
  const calls: [string, number][] = [];

  clock.schedule(() => {
    calls.push(['late', clock.now()]);
  }, 200);

  clock.schedule(() => {
    calls.push(['early', clock.now()]);
  }, 100);

  clock.advance(500);

  expect(calls).toStrictEqual([
    ['early', 100],
    ['late', 200],
  ]);
});

test('it runs a callback that a due callback schedules within the same step', () => {
  const clock = buildStubClock(0);
  const calls: number[] = [];

  clock.schedule(() => {
    clock.schedule(() => {
      calls.push(clock.now());
    }, 50);
  }, 100);

  clock.advance(200);

  expect(calls).toStrictEqual([150]);
});

test('it never runs a cancelled callback', () => {
  const clock = buildStubClock(0);
  const calls: number[] = [];

  const cancel = clock.schedule(() => {
    calls.push(clock.now());
  }, 100);

  cancel();

  clock.advance(200);

  expect(calls).toBeEmpty();
});

test('it collects the time left on each callback still waiting in due order', () => {
  const clock = buildStubClock(0);

  clock.schedule(() => {}, 500);
  clock.schedule(() => {}, 100);
  clock.schedule(() => {}, 300);
  clock.advance(200);

  expect(clock.collectPending()).toStrictEqual([100, 300]);
});
