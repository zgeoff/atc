import { expect, test } from 'bun:test';
import { buildCellBuffer } from '../compositor/build-cell-buffer';
import type { ColourDepth } from '../compositor/types';
import { buildMockPanelInput } from '../test-utils/build-mock-panel-input';
import { buildListPanel } from './build-list-panel';
import { paintPanel } from './paint-panel';
import { pickListMotion } from './pick-list-motion';

function setupTest() {
  const buffer = buildCellBuffer(60, 20);
  const plan = buildListPanel(buildMockPanelInput(), { cols: 60, rows: 20 });

  return {
    readBackground: (depth: ColourDepth) => {
      paintPanel(buffer, plan, {
        terminal: {
          depth,
          background: { red: 255, green: 255, blue: 255 },
          foreground: { red: 0, green: 0, blue: 0 },
          kittyKeyboard: false,
        },
        motion: pickListMotion({ kind: 'opening', startedAtMs: 0 }, 1000, {
          animations: true,
          rowCount: 1,
        }),
        dimShare: 0.5,
      });

      return buffer.get(plan.left + 1, plan.top + 1).bg;
    },
  };
}

test('#paintPanel leaves the panel on the default background at 16 colours', () => {
  const ctx = setupTest();

  expect(ctx.readBackground('16')).toStrictEqual({ kind: 'default' });
});

test('#paintPanel gives the panel an rgb background at truecolor', () => {
  const ctx = setupTest();

  expect(ctx.readBackground('truecolor')).toStrictEqual({
    kind: 'rgb',
    red: expect.any(Number),
    green: expect.any(Number),
    blue: expect.any(Number),
  });
});
