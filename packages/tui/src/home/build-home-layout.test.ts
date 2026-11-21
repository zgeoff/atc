import { expect, test } from 'bun:test';
import { buildHomeLayout } from './build-home-layout';
import type { HomeInput } from './types';

function setupTest() {
  const window = { cols: 100, rows: 30 };
  const wordmarkSize = { cols: 21, rows: 4 };

  const layOut = (override: Partial<HomeInput>) =>
    buildHomeLayout(window, { kind: 'bitmap' }, wordmarkSize, {
      sessionCount: 0,
      needYouCount: 0,
      leaderLabel: 'ctrl+space',
      notices: [],
      restorableCount: 0,
      ...override,
    });

  // the text of one row, with each run at its column
  const readLine = (layout: ReturnType<typeof layOut>, row: number): string => {
    const line: string[] = Array.from({ length: window.cols }, () => ' ');

    for (const run of layout.runs.filter((entry) => entry.row === row)) {
      for (const [index, ch] of [...run.text].entries()) {
        line[run.col + index] = ch;
      }
    }

    return line.join('').trimEnd();
  };

  return { layOut, readLine };
}

test.each([
  [0, 0, 'no sessions'],
  [1, 0, '1 session'],
  [15, 0, '15 sessions'],
  [15, 2, '15 sessions  ·  ◆ 2 need you'],
  [0, 1, 'no sessions  ·  ◆ 1 need you'],
])(
  '#buildHomeLayout words the fleet line for %i sessions and %i that need you',
  (count, need, line) => {
    const ctx = setupTest();
    const layout = ctx.layOut({ sessionCount: count, needYouCount: need });

    expect(ctx.readLine(layout, 15).trim()).toBe(line);
  },
);

test('#buildHomeLayout centres the stack and leaves two blank rows under an outline wordmark', () => {
  const layout = buildHomeLayout(
    { cols: 170, rows: 50 },
    { kind: 'outline', size: 's10' },
    { cols: 36, rows: 7 },
    {
      sessionCount: 3,
      needYouCount: 0,
      leaderLabel: 'ctrl+space',
      notices: [],
      restorableCount: 0,
    },
  );

  expect([
    layout.wordmarkAt,
    layout.runs.map((run) => run.row).filter((row, index, rows) => rows.indexOf(row) === index),
  ]).toStrictEqual([{ col: 67, row: 18 }, [27, 29, 30]]);
});

test('#buildHomeLayout aligns the keys to the right and starts the labels two columns later', () => {
  const ctx = setupTest();
  const layout = ctx.layOut({});

  expect([ctx.readLine(layout, 17), ctx.readLine(layout, 18)]).toStrictEqual([
    `${' '.repeat(40)}ctrl+space  sessions`,
    `${' '.repeat(49)}n  new`,
  ]);
});

test('#buildHomeLayout shows the leader key as the config gives it', () => {
  const ctx = setupTest();
  const layout = ctx.layOut({ leaderLabel: '^Space' });

  expect(ctx.readLine(layout, 17).trim()).toBe('^Space  sessions');
});

test('#buildHomeLayout marks the fleet line bold, amber and dim by part', () => {
  const ctx = setupTest();
  const layout = ctx.layOut({ sessionCount: 2, needYouCount: 1 });

  expect(
    layout.runs
      .filter((run) => run.row === 15)
      .map((run) => [run.text, run.tone, run.bold, run.dim]),
  ).toStrictEqual([
    ['2', 'plain', true, false],
    [' sessions', 'plain', false, true],
    ['  ·  ', 'plain', false, true],
    ['◆ ', 'amber', false, false],
    ['1', 'amber', true, false],
    [' need you', 'amber', false, true],
  ]);
});

test('#buildHomeLayout draws the text wordmark as bold text', () => {
  const layout = buildHomeLayout(
    { cols: 24, rows: 8 },
    { kind: 'text' },
    { cols: 3, rows: 1 },
    {
      sessionCount: 0,
      needYouCount: 0,
      leaderLabel: 'ctrl+space',
      notices: [],
      restorableCount: 0,
    },
  );

  expect(layout.runs[0]).toStrictEqual({
    col: 10,
    row: 1,
    text: 'atc',
    tone: 'mark',
    bold: true,
    dim: false,
  });
});

test('#buildHomeLayout puts the notices below the keys, so they never move the stack', () => {
  const ctx = setupTest();
  const plain = ctx.layOut({});
  const noticed = ctx.layOut({ notices: ['⟳ update ready'] });

  expect([
    noticed.runs.slice(0, plain.runs.length),
    ctx.readLine(noticed, 20).trim(),
  ]).toStrictEqual([[...plain.runs], '⟳ update ready']);
});

test('#buildHomeLayout lists the restore key while the last fleet has sessions to restore', () => {
  const ctx = setupTest();
  const layout = ctx.layOut({ restorableCount: 2 });

  expect([
    ctx.readLine(layout, 17),
    ctx.readLine(layout, 18),
    ctx.readLine(layout, 19),
  ]).toStrictEqual([
    `${' '.repeat(40)}ctrl+space  sessions`,
    `${' '.repeat(49)}n  new`,
    `${' '.repeat(49)}R  restore`,
  ]);
});
