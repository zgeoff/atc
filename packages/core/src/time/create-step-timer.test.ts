import { expect, test } from 'bun:test';
import { createStepTimer } from './create-step-timer';

test('it formats each step in the order it first ran, then the total', async () => {
  let now = 1000;
  const timer = createStepTimer(() => now);

  await timer.withStep('inspect-imp', () => {
    now += 40;

    return Promise.resolve();
  });

  await timer.withStep('lease', () => {
    now += 2500;

    return Promise.resolve();
  });

  now += 10;

  expect(timer.formatSteps()).toBe('inspect-imp 40, lease 2500, total 2550');
});

test('it adds up a step that runs more than once and counts its runs', async () => {
  let now = 0;
  const timer = createStepTimer(() => now);

  await timer.withStep('project-settings', () => {
    now += 30;

    return Promise.resolve();
  });

  await timer.withStep('project-settings', () => {
    now += 45;

    return Promise.resolve();
  });

  expect(timer.formatSteps()).toBe('project-settings 75 (x2), total 75');
});

test('it counts the time of a step that throws', async () => {
  let now = 0;
  const timer = createStepTimer(() => now);

  const failed = timer.withStep('lease', () => {
    now += 120;

    return Promise.reject(new Error('impd did not answer'));
  });

  await expect(failed).toReject();

  expect(timer.formatSteps()).toBe('lease 120, total 120');
});

test('it returns what the step resolves to', async () => {
  const timer = createStepTimer(() => 0);

  const home = await timer.withStep('host-home', () => Promise.resolve('/home/agent'));

  expect(home).toBe('/home/agent');
});
