import { expect, test } from 'bun:test';
import { buildCellBuffer } from '../compositor/build-cell-buffer';
import type { ColourDepth } from '../compositor/types';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { buildMockPanelInput } from '../test-utils/build-mock-panel-input';
import { buildListPanel } from './build-list-panel';
import { paintPanel } from './paint-panel';
import { pickListMotion } from './pick-list-motion';

function setupTest() {
  const buffer = buildCellBuffer(60, 20);

  const plan = buildListPanel(
    buildMockPanelInput({
      rows: [{ kind: 'session', session: buildMockMirrorSession({ name: 'api' }), via: null }],
    }),
    { cols: 60, rows: 20 },
  );

  const paint = (depth: ColourDepth, openedForMs: number) => {
    paintPanel(buffer, plan, {
      terminal: {
        depth,
        background: { red: 255, green: 255, blue: 255 },
        foreground: { red: 0, green: 0, blue: 0 },
        kittyKeyboard: false,
      },
      motion: pickListMotion({ kind: 'opening', startedAtMs: 0 }, openedForMs, {
        animations: true,
        rowCount: 1,
      }),
      dimShare: 0.5,
    });
  };

  return {
    readBackground: (depth: ColourDepth) => {
      paint(depth, 1000);

      return buffer.get(plan.left + 1, plan.top + 1).bg;
    },

    readEdges: (openedForMs: number) => {
      paint('truecolor', openedForMs);

      return {
        corner: buffer.get(plan.left, plan.top).fg,
        rowEdge: buffer.get(plan.left, plan.top + 1).fg,
      };
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

test('#paintPanel fades the side border of a row with the frame, not with the row', () => {
  const ctx = setupTest();
  const edges = ctx.readEdges(100);

  expect(edges.rowEdge).toStrictEqual(edges.corner);
});
