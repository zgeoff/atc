import { expect, test } from 'bun:test';
import { planOverlayColumns } from './plan-overlay-columns';

test('it gives a wide flat row every column at its content width', () => {
  expect(
    planOverlayColumns({
      innerWidth: 86,
      grouped: false,
      showTarget: true,
      targetMax: 5,
      harnessMax: 6,
      modelMax: 8,
    }),
  ).toStrictEqual({
    nameWidth: 16,
    dirWidth: 18,
    targetWidth: 5,
    harnessWidth: 6,
    modelWidth: 8,
    lifecycleWidth: 9,
    eventWidth: 14,
  });
});

test('it drops the directory column first under width pressure', () => {
  expect(
    planOverlayColumns({
      innerWidth: 72,
      grouped: false,
      showTarget: true,
      targetMax: 5,
      harnessMax: 6,
      modelMax: 8,
    }),
  ).toStrictEqual({
    nameWidth: 16,
    dirWidth: 14,
    targetWidth: 5,
    harnessWidth: 6,
    modelWidth: 8,
    lifecycleWidth: 9,
    eventWidth: 4,
  });
});

test('it crowds the model column out before the harness column yields', () => {
  expect(
    planOverlayColumns({
      innerWidth: 48,
      grouped: false,
      showTarget: true,
      targetMax: 5,
      harnessMax: 6,
      modelMax: 8,
    }),
  ).toStrictEqual({
    nameWidth: 16,
    dirWidth: 0,
    targetWidth: 5,
    harnessWidth: 6,
    modelWidth: 0,
    lifecycleWidth: 9,
    eventWidth: 4,
  });
});

test('it keeps the name, target, and harness after the last event gives way', () => {
  expect(
    planOverlayColumns({
      innerWidth: 40,
      grouped: false,
      showTarget: true,
      targetMax: 5,
      harnessMax: 6,
      modelMax: 8,
    }),
  ).toStrictEqual({
    nameWidth: 16,
    dirWidth: 0,
    targetWidth: 5,
    harnessWidth: 3,
    modelWidth: 0,
    lifecycleWidth: 9,
    eventWidth: 0,
  });
});

test('it crowds every column out rather than overflow a very narrow box', () => {
  expect(
    planOverlayColumns({
      innerWidth: 14,
      grouped: false,
      showTarget: true,
      targetMax: 5,
      harnessMax: 6,
      modelMax: 8,
    }),
  ).toStrictEqual({
    nameWidth: 0,
    dirWidth: 0,
    targetWidth: 0,
    harnessWidth: 0,
    modelWidth: 0,
    lifecycleWidth: 9,
    eventWidth: 0,
  });
});

test('it holds no target column while a single target is available', () => {
  expect(
    planOverlayColumns({
      innerWidth: 86,
      grouped: false,
      showTarget: false,
      targetMax: 5,
      harnessMax: 6,
      modelMax: 8,
    }),
  ).toStrictEqual({
    nameWidth: 16,
    dirWidth: 18,
    targetWidth: 0,
    harnessWidth: 6,
    modelWidth: 8,
    lifecycleWidth: 9,
    eventWidth: 20,
  });
});

test('it still draws the target column when every session sits on one target', () => {
  expect(
    planOverlayColumns({
      innerWidth: 86,
      grouped: false,
      showTarget: true,
      targetMax: 5,
      harnessMax: 6,
      modelMax: 8,
    }),
  ).toStrictEqual({
    nameWidth: 16,
    dirWidth: 18,
    targetWidth: 5,
    harnessWidth: 6,
    modelWidth: 8,
    lifecycleWidth: 9,
    eventWidth: 14,
  });
});

test('it holds no model column when no session runs an explicit model', () => {
  expect(
    planOverlayColumns({
      innerWidth: 86,
      grouped: false,
      showTarget: true,
      targetMax: 5,
      harnessMax: 6,
      modelMax: 0,
    }),
  ).toStrictEqual({
    nameWidth: 16,
    dirWidth: 18,
    targetWidth: 5,
    harnessWidth: 6,
    modelWidth: 0,
    lifecycleWidth: 9,
    eventWidth: 23,
  });
});

test('it caps a long model name at the preferred model width', () => {
  expect(
    planOverlayColumns({
      innerWidth: 86,
      grouped: false,
      showTarget: true,
      targetMax: 5,
      harnessMax: 6,
      modelMax: 24,
    }),
  ).toStrictEqual({
    nameWidth: 16,
    dirWidth: 18,
    targetWidth: 5,
    harnessWidth: 6,
    modelWidth: 14,
    lifecycleWidth: 9,
    eventWidth: 8,
  });
});

test('it drops the directory width in the grouped view', () => {
  expect(
    planOverlayColumns({
      innerWidth: 86,
      grouped: true,
      showTarget: true,
      targetMax: 5,
      harnessMax: 6,
      modelMax: 8,
    }),
  ).toStrictEqual({
    nameWidth: 16,
    dirWidth: 0,
    targetWidth: 5,
    harnessWidth: 6,
    modelWidth: 8,
    lifecycleWidth: 9,
    eventWidth: 33,
  });
});
