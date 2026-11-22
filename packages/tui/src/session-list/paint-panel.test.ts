import { expect, test } from 'bun:test';
import { buildCellBuffer } from '../compositor/build-cell-buffer';
import type { ColourDepth } from '../compositor/types';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { buildMockPanelInput } from '../test-utils/build-mock-panel-input';
import { buildListPanel } from './build-list-panel';
import { HIDDEN_FADE } from './constants';
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
      motion: pickListMotion({ kind: 'opening', startedAtMs: 0, from: HIDDEN_FADE }, openedForMs, {
        animations: true,
        rowCount: 1,
      }),
      dimShare: 0.5,
    });
  };

  return {
    // the panel rows, counted from its top, that hold a cell off the default background
    readTintedRows: (selected: number) => {
      const tintBuffer = buildCellBuffer(60, 20);

      const tintPlan = buildListPanel(
        buildMockPanelInput({
          selected,
          rows: [{ kind: 'session', session: buildMockMirrorSession({ name: 'api' }), via: null }],
        }),
        { cols: 60, rows: 20 },
      );

      paintPanel(tintBuffer, tintPlan, {
        terminal: {
          depth: 'truecolor',
          background: { red: 255, green: 255, blue: 255 },
          foreground: { red: 0, green: 0, blue: 0 },
          kittyKeyboard: false,
        },
        motion: pickListMotion({ kind: 'opening', startedAtMs: 0, from: HIDDEN_FADE }, 1000, {
          animations: true,
          rowCount: 1,
        }),
        dimShare: 0.5,
      });

      const rows: number[] = [];

      for (let row = tintPlan.top; row < 19; row++) {
        const isTinted = Array.from({ length: tintPlan.width }, (_cell, offset) =>
          tintBuffer.get(tintPlan.left + offset, row),
        ).some((cell) => cell.bg.kind !== 'default');

        if (isTinted) {
          rows.push(row - tintPlan.top);
        }
      }

      return rows;
    },

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

test('#paintPanel leaves the panel on the default background at truecolor', () => {
  const ctx = setupTest();

  expect(ctx.readBackground('truecolor')).toStrictEqual({ kind: 'default' });
});

test('#paintPanel gives no cell a background when no row is selected', () => {
  const ctx = setupTest();

  expect(ctx.readTintedRows(-1)).toStrictEqual([]);
});

test('#paintPanel tints only the selected row', () => {
  const ctx = setupTest();

  expect(ctx.readTintedRows(0)).toStrictEqual([1]);
});

test('#paintPanel fades the side border of a row with the frame, not with the row', () => {
  const ctx = setupTest();
  const edges = ctx.readEdges(100);

  expect(edges.rowEdge).toStrictEqual(edges.corner);
});
