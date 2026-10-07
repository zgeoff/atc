import { expect, jest, mock, onTestFinished, spyOn, test } from 'bun:test';
import { ScreenModel } from './screen-model';
import { SessionRuntime } from './session-runtime';

test('it stops its screen model on dispose', () => {
  const runtime = new SessionRuntime();
  const model = new ScreenModel(20, 5);

  const stop = spyOn(model, 'stop');

  runtime.screen = model;

  runtime.dispose();

  expect(stop).toHaveBeenCalledOnce();
  expect(runtime.screen).toBeNull();
});

test('it clears its resize, detect, and boot timers on dispose so they never fire', () => {
  jest.useFakeTimers();

  onTestFinished(() => jest.useRealTimers());

  const runtime = new SessionRuntime();

  const resize = mock(() => {});
  const detect = mock(() => {});
  const boot = mock(() => {});

  runtime.resizeTimer = setTimeout(resize, 20);
  runtime.detectTimer = setTimeout(detect, 20);
  runtime.bootTimer = setTimeout(boot, 20);

  runtime.dispose();
  jest.advanceTimersByTime(20);

  expect(resize).not.toHaveBeenCalled();
  expect(detect).not.toHaveBeenCalled();
  expect(boot).not.toHaveBeenCalled();
});

test('it leaves its resize, detect, and boot timers to fire while it is not disposed', () => {
  jest.useFakeTimers();

  onTestFinished(() => jest.useRealTimers());

  const runtime = new SessionRuntime();

  const resize = mock(() => {});
  const detect = mock(() => {});
  const boot = mock(() => {});

  runtime.resizeTimer = setTimeout(resize, 20);
  runtime.detectTimer = setTimeout(detect, 20);
  runtime.bootTimer = setTimeout(boot, 20);

  jest.advanceTimersByTime(20);

  expect(resize).toHaveBeenCalledOnce();
  expect(detect).toHaveBeenCalledOnce();
  expect(boot).toHaveBeenCalledOnce();
});

test('it stops a live headless run on dispose', () => {
  const runtime = new SessionRuntime();

  const stop = mock(() => {});

  runtime.headlessRun = { stop };

  runtime.dispose();

  expect(stop).toHaveBeenCalledOnce();
  expect(runtime.headlessRun).toBeNull();
});

test('it settles a pending eject waiter on dispose', () => {
  const runtime = new SessionRuntime();

  const resolve = mock(() => {});

  runtime.pendingEject = resolve;

  runtime.dispose();

  expect(resolve).toHaveBeenCalledOnce();
  expect(runtime.pendingEject).toBeNull();
});

test('it settles a pending boot waiter on dispose', () => {
  const runtime = new SessionRuntime();

  const resolve = mock(() => {});

  runtime.bootWaiter = resolve;

  runtime.dispose();

  expect(resolve).toHaveBeenCalledOnce();
  expect(runtime.bootWaiter).toBeNull();
});

test('it releases each resource only once when disposed twice', () => {
  const runtime = new SessionRuntime();
  const model = new ScreenModel(20, 5);

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
