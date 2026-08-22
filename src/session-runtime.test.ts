import { expect, spyOn, test } from 'bun:test';
import { ScreenModel } from './screen-model';
import { SessionRuntime } from './session-runtime';

test('it stops its screen model on dispose', () => {
  const runtime = new SessionRuntime();
  const model = new ScreenModel(20, 5);

  const stop = spyOn(model, 'stop');

  runtime.screen = model;

  runtime.dispose();

  expect(stop).toHaveBeenCalledTimes(1);
  expect(runtime.screen).toBeNull();
});

test('it clears its resize, detect, and boot timers on dispose so they never fire', async () => {
  const runtime = new SessionRuntime();

  let resizeFired = false;
  let detectFired = false;
  let bootFired = false;

  runtime.resizeTimer = setTimeout(() => {
    resizeFired = true;
  }, 20);

  runtime.detectTimer = setTimeout(() => {
    detectFired = true;
  }, 20);

  runtime.bootTimer = setTimeout(() => {
    bootFired = true;
  }, 20);

  runtime.dispose();

  await Bun.sleep(40);

  expect(resizeFired).toBe(false);
  expect(detectFired).toBe(false);
  expect(bootFired).toBe(false);
});

test('it stops a live headless run on dispose', () => {
  const runtime = new SessionRuntime();

  let stopped = false;

  runtime.headlessRun = {
    stop() {
      stopped = true;
    },
  };

  runtime.dispose();

  expect(stopped).toBe(true);
  expect(runtime.headlessRun).toBeNull();
});

test('it settles a pending eject waiter on dispose', () => {
  const runtime = new SessionRuntime();

  let resolved = false;

  runtime.pendingEject = () => {
    resolved = true;
  };

  runtime.dispose();

  expect(resolved).toBe(true);
  expect(runtime.pendingEject).toBeNull();
});

test('it settles a pending boot waiter on dispose', () => {
  const runtime = new SessionRuntime();

  let resolved = false;

  runtime.bootWaiter = () => {
    resolved = true;
  };

  runtime.dispose();

  expect(resolved).toBe(true);
  expect(runtime.bootWaiter).toBeNull();
});

test('it is safe to dispose twice', () => {
  const runtime = new SessionRuntime();
  const model = new ScreenModel(20, 5);

  const stop = spyOn(model, 'stop');
  let headlessStops = 0;
  let ejectResolves = 0;
  let bootResolves = 0;

  runtime.screen = model;

  runtime.headlessRun = {
    stop() {
      headlessStops++;
    },
  };

  runtime.pendingEject = () => {
    ejectResolves++;
  };

  runtime.bootWaiter = () => {
    bootResolves++;
  };

  runtime.dispose();
  runtime.dispose();

  expect(stop).toHaveBeenCalledTimes(1);
  expect(headlessStops).toBe(1);
  expect(ejectResolves).toBe(1);
  expect(bootResolves).toBe(1);
});
