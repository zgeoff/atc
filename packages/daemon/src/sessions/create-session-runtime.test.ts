import { expect, mock, onTestFinished, spyOn, test } from 'bun:test';
import { buildStubClock } from '@atc/test-utils';
import { createScreenModel } from './create-screen-model';
import { createSessionRuntime } from './create-session-runtime';

test('it starts with no hook state', () => {
  expect(createSessionRuntime().harnessState).toBeUndefined();
});

test('it drops the hook state of the previous terminal when a new one boots', () => {
  const runtime = createSessionRuntime();

  runtime.harnessState = { latestPromptID: 'p-1' };

  runtime.resetBoot({ cols: 80, rows: 24 });

  expect(runtime.harnessState).toBeUndefined();
});

test('it stops its screen model on dispose', () => {
  const runtime = createSessionRuntime();
  const model = createScreenModel(20, 5);

  onTestFinished(() => {
    model.stop();
  });

  const stop = spyOn(model, 'stop');

  runtime.screen = model;

  runtime.dispose();

  expect(stop).toHaveBeenCalledOnce();
  expect(runtime.screen).toBeNull();
});

test('it clears its resize and detect timers on dispose so they never fire', () => {
  const clock = buildStubClock(0);
  const runtime = createSessionRuntime();
  const resize = mock(() => {});
  const detect = mock(() => {});

  runtime.cancelResize = clock.schedule(resize, 20);
  runtime.cancelDetect = clock.schedule(detect, 20);

  runtime.dispose();
  clock.advance(20);

  expect(resize).not.toHaveBeenCalled();
  expect(detect).not.toHaveBeenCalled();
});

test('it leaves its resize and detect timers to fire when it stops only its headless run', () => {
  const clock = buildStubClock(0);
  const runtime = createSessionRuntime();
  const resize = mock(() => {});
  const detect = mock(() => {});

  runtime.cancelResize = clock.schedule(resize, 20);
  runtime.cancelDetect = clock.schedule(detect, 20);
  runtime.headlessRun = { stop: () => {} };

  runtime.stopHeadlessRun();
  clock.advance(20);

  expect(resize).toHaveBeenCalledOnce();
  expect(detect).toHaveBeenCalledOnce();
});

test('it stops a live headless run on dispose', () => {
  const runtime = createSessionRuntime();
  const stop = mock(() => {});

  runtime.headlessRun = { stop };

  runtime.dispose();

  expect(stop).toHaveBeenCalledOnce();
  expect(runtime.headlessRun).toBeNull();
});

test('it settles a pending eject waiter on dispose', () => {
  const runtime = createSessionRuntime();
  const resolve = mock(() => {});

  runtime.pendingEject = resolve;

  runtime.dispose();

  expect(resolve).toHaveBeenCalledOnce();
  expect(runtime.pendingEject).toBeNull();
});

test('it settles a pending boot waiter on dispose', () => {
  const runtime = createSessionRuntime();
  const resolve = mock(() => {});

  runtime.bootWaiter = resolve;

  runtime.dispose();

  expect(resolve).toHaveBeenCalledOnce();
  expect(runtime.bootWaiter).toBeNull();
});

test('it releases each resource only once when disposed twice', () => {
  const runtime = createSessionRuntime();
  const model = createScreenModel(20, 5);

  onTestFinished(() => {
    model.stop();
  });

  const stopScreen = spyOn(model, 'stop');
  const stopHeadless = mock(() => {});
  const resolveEject = mock(() => {});
  const resolveBoot = mock(() => {});

  runtime.screen = model;
  runtime.headlessRun = { stop: stopHeadless };
  runtime.pendingEject = resolveEject;
  runtime.bootWaiter = resolveBoot;

  runtime.dispose();
  runtime.dispose();

  expect(stopScreen).toHaveBeenCalledOnce();
  expect(stopHeadless).toHaveBeenCalledOnce();
  expect(resolveEject).toHaveBeenCalledOnce();
  expect(resolveBoot).toHaveBeenCalledOnce();
});
