import { expect, test } from 'bun:test';
import { planOverlayColumns } from './plan-overlay-columns';

// A flat overlay whose every column draws, at the width a 90-column box
// holds inside; each test overrides the one pressure its case is about.
function plan(
  overrides: Partial<Parameters<typeof planOverlayColumns>[0]> = {},
): ReturnType<typeof planOverlayColumns> {
  return planOverlayColumns({
    innerWidth: 86,
    grouped: false,
    showTarget: true,
    targetMax: 5,
    harnessMax: 6,
    modelMax: 8,
    ...overrides,
  });
}

test('it gives a wide flat row every column at its content width', () => {
  const p = plan();

  expect(p.nameWidth).toBe(16);
  expect(p.dirWidth).toBe(18);
  expect(p.targetWidth).toBe(5);
  expect(p.harnessWidth).toBe(6);
  expect(p.modelWidth).toBe(8);
  expect(p.lifecycleWidth).toBe(9);
  expect(p.eventWidth).toBe(14);
});

test('it drops the directory column first under width pressure', () => {
  const p = plan({ innerWidth: 72 });

  expect(p.dirWidth).toBe(14);
  expect(p.modelWidth).toBe(8);
  expect(p.nameWidth).toBe(16);
  expect(p.targetWidth).toBe(5);
  expect(p.harnessWidth).toBe(6);
  expect(p.lifecycleWidth).toBe(9);
  expect(p.eventWidth).toBe(4);
});

test('it crowds the model column out before the harness column yields', () => {
  const p = plan({ innerWidth: 48 });

  expect(p.dirWidth).toBe(0);
  expect(p.modelWidth).toBe(0);
  expect(p.harnessWidth).toBe(6);
  expect(p.targetWidth).toBe(5);
  expect(p.nameWidth).toBe(16);
  expect(p.lifecycleWidth).toBe(9);
  expect(p.eventWidth).toBe(4);
});

test('it keeps the name, target, and harness after the last event gives way', () => {
  const p = plan({ innerWidth: 40 });

  expect(p.eventWidth).toBe(0);
  expect(p.modelWidth).toBe(0);
  expect(p.dirWidth).toBe(0);
  expect(p.harnessWidth).toBe(3);
  expect(p.targetWidth).toBe(5);
  expect(p.nameWidth).toBe(16);
  expect(p.lifecycleWidth).toBe(9);
});

test('it crowds every column out rather than overflow a very narrow box', () => {
  const p = plan({ innerWidth: 14 });

  expect(p.nameWidth).toBe(0);
  expect(p.targetWidth).toBe(0);
  expect(p.harnessWidth).toBe(0);
  expect(p.eventWidth).toBe(0);
  expect(p.lifecycleWidth).toBe(9);
});

test('it holds no target column while a single target is available', () => {
  const p = plan({ showTarget: false });

  expect(p.targetWidth).toBe(0);
  expect(p.eventWidth).toBe(20);
});

test('it still draws the target column when every session sits on one target', () => {
  const p = plan({ showTarget: true, targetMax: 5 });

  expect(p.targetWidth).toBe(5);
});

test('it holds no model column when no session runs an explicit model', () => {
  const p = plan({ modelMax: 0 });

  expect(p.modelWidth).toBe(0);
  expect(p.eventWidth).toBe(23);
});

test('it caps a long model name at the preferred model width', () => {
  const p = plan({ modelMax: 24 });

  expect(p.modelWidth).toBe(14);
});

test('it drops the directory width in the grouped view', () => {
  const p = plan({ grouped: true });

  expect(p.dirWidth).toBe(0);
  expect(p.eventWidth).toBe(33);
});
