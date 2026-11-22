import { expect, test } from 'bun:test';
import { measureWidth } from '../terminal/measure-width';
import { buildFleetBar } from './build-fleet-bar';
import { formatFleetBar } from './format-fleet-bar';
import type { FleetBarRun } from './format-fleet-bar';
import type { FleetBarSession } from './types';

function setupTest() {
  const sessions: FleetBarSession[] = [
    { daemon: null, state: 'needs_you', target: 'box', place: { key: 'a', label: 'laptop' } },
    { daemon: null, state: 'running', target: 'box', place: { key: 'a', label: 'laptop' } },
    { daemon: null, state: 'running', target: 'box', place: { key: 'a', label: 'laptop' } },
    { daemon: null, state: 'done', target: 'box', place: { key: 'a', label: 'laptop' } },
    { daemon: null, state: 'exited', target: 'box', place: { key: 'a', label: 'laptop' } },
    { daemon: null, state: 'done', target: 'box', place: { key: 'a', label: 'laptop' } },
    { daemon: null, state: 'running', target: 'box', place: { key: 'b', label: 'docker' } },
    { daemon: null, state: 'needs_you', target: 'box', place: { key: 'c', label: 'ink' } },
    { daemon: null, state: 'done', target: 'box', place: { key: 'c', label: 'ink' } },
  ];

  return { sessions };
}

test.each([
  {
    title: 'glyphs',
    cols: 100,
    expected: `  docker ⠋  ink ◆ ✓  laptop ◆ ⠋ ⠋ ✓ +2${' '.repeat(35)}◆ 2 need you   ctrl+space  `,
  },
  {
    title: 'counts',
    cols: 54,
    expected: `  docker 1  ink 2 ◆  laptop 6 ◆${' '.repeat(5)}◆ 2   ctrl+space  `,
  },
  {
    title: 'short',
    cols: 48,
    expected: `  doc 1  ink 2 ◆  lap 6 ◆${' '.repeat(5)}◆ 2   ctrl+space  `,
  },
  {
    title: 'short with … for the places that dropped',
    cols: 30,
    expected: `  doc 1…${' '.repeat(4)}◆ 2   ctrl+space  `,
  },
])('#formatFleetBar draws the $title level on one row', (row) => {
  const ctx = setupTest();

  const bar = buildFleetBar(ctx.sessions, {
    cols: row.cols,
    leaderLabel: 'ctrl+space',
    attachedPlaceKey: null,
  });

  const text = Array.from({ length: row.cols }, () => ' ');

  for (const run of formatFleetBar(bar, row.cols)) {
    run.text.split('').forEach((ch, index) => {
      text[run.col + index] = ch;
    });
  }

  expect(text.join('')).toBe(row.expected);
});

test('#formatFleetBar writes the need-you count in amber and the leader in bold blue', () => {
  const ctx = setupTest();

  const bar = buildFleetBar(ctx.sessions, {
    cols: 100,
    leaderLabel: 'ctrl+space',
    attachedPlaceKey: null,
  });

  expect(formatFleetBar(bar, 100).slice(-2)).toStrictEqual([
    {
      col: 73,
      text: '◆ 2 need you',
      fg: { kind: 'rgb', red: 0xf0, green: 0xb4, blue: 0x5a },
      bold: false,
    },
    {
      col: 88,
      text: 'ctrl+space',
      fg: { kind: 'rgb', red: 0x7a, green: 0xa2, blue: 0xf7 },
      bold: true,
    },
  ]);
});

test('#formatFleetBar leaves out the words under 90 columns', () => {
  const ctx = setupTest();

  const bar = buildFleetBar(ctx.sessions, {
    cols: 89,
    leaderLabel: 'ctrl+space',
    attachedPlaceKey: null,
  });

  expect(formatFleetBar(bar, 89).at(-2)?.text).toBe('◆ 2');
});

test('#formatFleetBar draws every glyph of an unreachable place in #3a414b', () => {
  const ctx = setupTest();

  const bar = buildFleetBar(ctx.sessions, {
    cols: 100,
    leaderLabel: 'ctrl+space',
    attachedPlaceKey: null,
    downDaemons: new Set([null]),
  });

  const colours = formatFleetBar(bar, 100)
    .filter((run) => run.text === ' ◆' || run.text === ' ⠋')
    .map((run) => run.fg);

  expect(colours.length).toBeGreaterThan(0);

  expect(colours).toStrictEqual(
    colours.map(() => ({ kind: 'rgb', red: 0x3a, green: 0x41, blue: 0x4b })),
  );
});

test('#formatFleetBar starts the next run after the two columns of a wide label', () => {
  const bar = buildFleetBar(
    [{ daemon: null, state: 'done', target: 'box', place: { key: 'a', label: '界界' } }],
    {
      cols: 100,
      leaderLabel: 'ctrl+space',
      attachedPlaceKey: null,
    },
  );

  expect(
    formatFleetBar(bar, 100)
      .slice(0, 2)
      .map((run) => [run.col, run.text]),
  ).toStrictEqual([
    [2, '界界'],
    [6, ' ✓'],
  ]);
});

test.each(Array.from({ length: 25 }, (_, cols) => ({ cols })))(
  '#formatFleetBar keeps the two columns at each end blank at $cols columns',
  (row) => {
    const ctx = setupTest();

    const bar = buildFleetBar(ctx.sessions, {
      cols: row.cols,
      leaderLabel: 'ctrl+space',
      attachedPlaceKey: null,
    });

    expect(formatFleetBar(bar, row.cols)).toSatisfyAll(
      (run: FleetBarRun) => run.col >= 2 && run.col + measureWidth(run.text) <= row.cols - 2,
    );
  },
);

test.each([
  { cols: 12, expected: `${' '.repeat(7)}◆ 2  ` },
  { cols: 6, expected: ' '.repeat(6) },
])('#formatFleetBar drops the leader label, then the need-you count, at $cols columns', (row) => {
  const ctx = setupTest();

  const bar = buildFleetBar(ctx.sessions, {
    cols: row.cols,
    leaderLabel: 'ctrl+space',
    attachedPlaceKey: null,
  });

  const text = Array.from({ length: row.cols }, () => ' ');

  for (const run of formatFleetBar(bar, row.cols)) {
    run.text.split('').forEach((ch, index) => {
      text[run.col + index] = ch;
    });
  }

  expect(text.join('')).toBe(row.expected);
});

test.each([
  ...Array.from({ length: 6 }, (_, index) => ({
    cols: 17 + index,
    expected: `${' '.repeat(5 + index)}ctrl+space  `,
  })),
  ...Array.from({ length: 6 }, (_, index) => ({
    cols: 23 + index,
    expected: `  box 2…${' '.repeat(3 + index)}ctrl+space  `,
  })),
])(
  '#formatFleetBar draws no bare … and keeps a gap before the right end at $cols columns',
  (row) => {
    const sessions: FleetBarSession[] = [
      { daemon: null, state: 'done', target: 'box', place: { key: 'l', label: 'local' } },
      { daemon: null, state: 'done', target: 'box', place: { key: 'l', label: 'local' } },
      { daemon: null, state: 'done', target: 'box', place: { key: 'l', label: 'local' } },
      { daemon: null, state: 'done', target: 'box', place: { key: 'b', label: 'box-1' } },
      { daemon: null, state: 'done', target: 'box', place: { key: 'b', label: 'box-1' } },
      { daemon: null, state: 'done', target: 'box', place: { key: 'z', label: 'zed' } },
    ];

    const bar = buildFleetBar(sessions, {
      cols: row.cols,
      leaderLabel: 'ctrl+space',
      attachedPlaceKey: null,
    });

    const text = Array.from({ length: row.cols }, () => ' ');

    for (const run of formatFleetBar(bar, row.cols)) {
      run.text.split('').forEach((ch, index) => {
        text[run.col + index] = ch;
      });
    }

    expect(text.join('')).toBe(row.expected);
  },
);
