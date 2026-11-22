import { expect, test } from 'bun:test';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { buildMockPanelInput } from '../test-utils/build-mock-panel-input';
import { renderPanelText } from '../test-utils/render-panel-text';
import { buildListPanel } from './build-list-panel';
import { BLUE } from './constants';

test('it centres a panel of min(112, cols - 8) columns', () => {
  const wide = buildListPanel(buildMockPanelInput(), { cols: 200, rows: 30 });
  const narrow = buildListPanel(buildMockPanelInput(), { cols: 100, rows: 30 });

  expect([wide.width, wide.left, narrow.width, narrow.left]).toStrictEqual([112, 44, 92, 4]);
});

test('it titles the panel with the session count and the sessions that need the user', () => {
  const plan = buildListPanel(
    buildMockPanelInput({
      rows: [
        { kind: 'session', session: buildMockMirrorSession({ state: 'needs_you' }), via: null },
        { kind: 'session', session: buildMockMirrorSession({ state: 'running' }), via: null },
      ],
      selected: 0,
    }),
    { cols: 120, rows: 30 },
  );

  expect(renderPanelText(plan)[0]).toBe(`╭─ 2 sessions · ◆ 1 need you ${'─'.repeat(82)}╮`);
});

test('it cuts a long title with … and keeps the top right corner', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    kind: 'session' as const,
    session: buildMockMirrorSession({ state: index % 3 === 0 ? 'needs_you' : 'done' }),
    via: null,
  }));

  const plan = buildListPanel(buildMockPanelInput({ rows, grouping: 'place' }), {
    cols: 40,
    rows: 20,
  });

  expect(renderPanelText(plan)[0]).toBe('╭─ 12 sessions · by place · … ─╮');
});

test('it cuts a long group label with … and keeps its count and need-you mark', () => {
  const plan = buildListPanel(
    buildMockPanelInput({
      grouping: 'repo',
      rows: [
        {
          kind: 'header',
          label: '~/projects/a-very-long-repository-name/that/keeps/going/on',
          count: 3,
          needYou: 2,
        },
        { kind: 'session', session: buildMockMirrorSession(), via: null },
      ],
      selected: 0,
    }),
    { cols: 60, rows: 20 },
  );

  expect(renderPanelText(plan)[1]).toBe('│ ~/projects/a-very-long-repository-name/…  3  ◆ 2 │');
});

test.each([
  { cols: 20, expected: '├──── ↑ 19  ↓ 19 ──┤' },
  { cols: 12, expected: '├──────────┤' },
])('it fits the hidden counts between the divider corners in $cols columns', (row) => {
  const rows = Array.from({ length: 40 }, () => ({
    kind: 'session' as const,
    session: buildMockMirrorSession(),
    via: null,
  }));

  const plan = buildListPanel(buildMockPanelInput({ rows, selected: 20 }), {
    cols: row.cols,
    rows: 12,
  });

  expect(renderPanelText(plan).at(-3)).toBe(row.expected);
});

test.each([
  { grouping: 'repo', expected: ' · by repo' },
  { grouping: 'place', expected: ' · by place' },
] as const)('it adds $expected to the title of a panel grouped by $grouping', (row) => {
  const plan = buildListPanel(buildMockPanelInput({ grouping: row.grouping }), {
    cols: 120,
    rows: 30,
  });

  expect(renderPanelText(plan)[0]).toInclude(`0 sessions${row.expected}`);
});

test('it draws a group header with its count and the sessions that need the user', () => {
  const plan = buildListPanel(
    buildMockPanelInput({
      grouping: 'place',
      rows: [
        { kind: 'header', label: 'sprite', count: 2, needYou: 1 },
        { kind: 'session', session: buildMockMirrorSession({ name: 'api' }), via: null },
      ],
      selected: 0,
    }),
    { cols: 120, rows: 30 },
  );

  expect(renderPanelText(plan)[1]).toStartWith('│ sprite  2  ◆ 1 ─');
});

test('it draws the side borders on a session row and a group header', () => {
  const plan = buildListPanel(
    buildMockPanelInput({
      grouping: 'repo',
      rows: [
        { kind: 'header', label: 'shop', count: 1, needYou: 0 },
        { kind: 'session', session: buildMockMirrorSession({ name: 'api' }), via: null },
      ],
      selected: 0,
    }),
    { cols: 120, rows: 30 },
  );

  const lines = renderPanelText(plan);

  expect([lines[1], lines[2]].map((line) => [line?.at(0), line?.at(-1)])).toStrictEqual([
    ['│', '│'],
    ['│', '│'],
  ]);
});

test('it separates two groups with one blank line', () => {
  const plan = buildListPanel(
    buildMockPanelInput({
      grouping: 'repo',
      rows: [
        { kind: 'header', label: 'one', count: 1, needYou: 0 },
        { kind: 'session', session: buildMockMirrorSession({ name: 'api' }), via: null },
        { kind: 'header', label: 'two', count: 1, needYou: 0 },
        { kind: 'session', session: buildMockMirrorSession({ name: 'web' }), via: null },
      ],
    }),
    { cols: 120, rows: 30 },
  );

  const lines = renderPanelText(plan);

  expect([lines[3], lines[4]?.startsWith('│ two  1 ─')]).toStrictEqual([
    `│${' '.repeat(110)}│`,
    true,
  ]);
});

test('it shows the daemon column only with more than one daemon', () => {
  const rows = [
    {
      kind: 'session',
      session: buildMockMirrorSession({ name: 'api', daemon: 'harbor' }),
      via: null,
    },
  ] as const;

  const one = buildListPanel(buildMockPanelInput({ rows }), { cols: 120, rows: 30 });

  const two = buildListPanel(buildMockPanelInput({ rows, showDaemon: true }), {
    cols: 120,
    rows: 30,
  });

  expect([renderPanelText(one)[1], renderPanelText(two)[1]]).toStrictEqual([
    expect.not.toInclude('harbor'),
    expect.toInclude('harbor'),
  ]);
});

test('it never shows the daemon column in place mode, and puts via in the place slot', () => {
  const plan = buildListPanel(
    buildMockPanelInput({
      grouping: 'place',
      showDaemon: true,
      rows: [
        { kind: 'header', label: 'cloud', count: 1, needYou: 0 },
        {
          kind: 'session',
          session: buildMockMirrorSession({ name: 'api', daemon: 'harbor' }),
          via: 'harbor',
        },
      ],
    }),
    { cols: 120, rows: 30 },
  );

  const row = renderPanelText(plan)[2] ?? '';

  expect(row.match(/harbor/gu)?.length).toBe(1);
  expect(row).toInclude('via harbor');
});

test('it drops the place column in place mode and the repository column in repo mode', () => {
  const session = buildMockMirrorSession({
    name: 'api',
    place: { key: 'k', label: 'sprite' },
    repoRoot: '/work/shop',
  });

  const rows = [{ kind: 'session', session, via: null }] as const;

  const place = buildListPanel(buildMockPanelInput({ rows, grouping: 'place' }), {
    cols: 140,
    rows: 30,
  });

  const repo = buildListPanel(buildMockPanelInput({ rows, grouping: 'repo' }), {
    cols: 140,
    rows: 30,
  });

  const flat = buildListPanel(buildMockPanelInput({ rows }), { cols: 140, rows: 30 });

  expect(
    [place, repo, flat].map((plan) => renderPanelText(plan)[1]?.includes('sprite')),
  ).toStrictEqual([false, true, true]);

  expect(
    [place, repo, flat].map((plan) => renderPanelText(plan)[1]?.includes('/work/shop')),
  ).toStrictEqual([true, false, true]);
});

test('it shows only the glyph, name, message and age under 90 columns', () => {
  const plan = buildListPanel(
    buildMockPanelInput({
      rows: [
        {
          kind: 'session',
          session: buildMockMirrorSession({
            name: 'api',
            lastMsg: 'turn done',
            place: { key: 'k', label: 'sprite' },
            state: 'done',
            stateSince: 0,
          }),
          via: null,
        },
      ],
      nowMs: 4 * 60_000,
    }),
    { cols: 89, rows: 30 },
  );

  const row = renderPanelText(plan)[1] ?? '';

  expect(row).toInclude('api');
  expect(row).toInclude('turn done');
  expect(row).toEndWith('4m │');
  expect(row).not.toInclude('sprite');
  expect(row).not.toInclude('claude');
});

test.each([
  {
    title: 'needs you: before the message of a session in needs_you',
    patch: { state: 'needs_you', lastMsg: 'run it?' },
    expected: 'needs you: run it?',
  },
  {
    title: 'asleep for a session whose machine sleeps',
    patch: { hostAsleep: true, lastMsg: 'x' },
    expected: 'asleep',
  },
  {
    title: 'suspended for a session whose agent is suspended',
    patch: { harness: 'suspended', lastMsg: 'x' },
    expected: 'suspended',
  },
] as const)('it shows $title', (row) => {
  const plan = buildListPanel(
    buildMockPanelInput({
      rows: [{ kind: 'session', session: buildMockMirrorSession(row.patch), via: null }],
    }),
    { cols: 120, rows: 30 },
  );

  expect(renderPanelText(plan)[1]).toInclude(row.expected);
});

test('it starts a sub-session name with an arrow', () => {
  const parent = buildMockMirrorSession({ id: 'p', name: 'parent' });
  const child = buildMockMirrorSession({ id: 'c', name: 'child', parent: 'p' });

  const plan = buildListPanel(
    buildMockPanelInput({
      rows: [
        { kind: 'session', session: parent, via: null },
        { kind: 'session', session: child, via: null },
      ],
    }),
    { cols: 120, rows: 30 },
  );

  expect(renderPanelText(plan)[2]).toInclude('↳ child');
});

test('it scrolls with the selection and counts the rows left out below and above', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    kind: 'session' as const,
    session: buildMockMirrorSession({ id: `s-${index}`, name: `session-${index}` }),
    via: null,
  }));

  const top = buildListPanel(buildMockPanelInput({ rows, selected: 0 }), { cols: 120, rows: 24 });

  const middle = buildListPanel(buildMockPanelInput({ rows, selected: 15 }), {
    cols: 120,
    rows: 24,
  });

  const bottom = buildListPanel(buildMockPanelInput({ rows, selected: 29 }), {
    cols: 120,
    rows: 24,
  });

  const dividers = [top, middle, bottom].map((plan) => {
    const text = renderPanelText(plan);

    return text.at(-3)?.replaceAll(/[─├┤]/gu, '').trim();
  });

  expect(dividers).toStrictEqual(['↓ 16 more', '↑ 8 more  ↓ 8 more', '↑ 16 more']);
});

test('it keeps the panel within rows - 6 lines', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    kind: 'session' as const,
    session: buildMockMirrorSession({ id: `s-${index}` }),
    via: null,
  }));

  const plan = buildListPanel(buildMockPanelInput({ rows }), { cols: 120, rows: 24 });

  expect(renderPanelText(plan)).toHaveLength(18);
});

test.each([
  {
    title: 'a prompt over a filter and a notice',
    input: { prompt: 'kill api? · y / n', filter: 'x', notice: 'kept shop' },
    expected: 'kill api? · y / n',
  },
  { title: 'the filter with its cursor', input: { filter: 'ab' }, expected: '/ ab█' },
  {
    title: 'a notice over the key bar',
    input: { notice: 'kept shop: 2 files' },
    expected: 'kept shop: 2 files',
  },
  { title: 'the key bar with nothing else', input: {}, expected: 'n new   ? keys' },
])('it puts $title on the last line', (row) => {
  const plan = buildListPanel(buildMockPanelInput(row.input), { cols: 120, rows: 30 });
  const text = renderPanelText(plan);

  expect(text.at(-2)).toInclude(row.expected);
});

test('it says no sessions for an empty list and no matches under a filter', () => {
  const empty = buildListPanel(buildMockPanelInput(), { cols: 120, rows: 30 });
  const filtered = buildListPanel(buildMockPanelInput({ filter: 'zz' }), { cols: 120, rows: 30 });

  expect([renderPanelText(empty)[1], renderPanelText(filtered)[1]]).toStrictEqual([
    `${'│ no sessions — n to spawn'.padEnd(111)}│`,
    `${'│ no matches'.padEnd(111)}│`,
  ]);
});

test('it writes a jump label over the letter after the first match, and fades the rows with none', () => {
  const plan = buildListPanel(
    buildMockPanelInput({
      rows: [
        { kind: 'session', session: buildMockMirrorSession({ name: 'tui' }), via: null },
        { kind: 'session', session: buildMockMirrorSession({ name: 'cat' }), via: null },
        { kind: 'session', session: buildMockMirrorSession({ name: 'web' }), via: null },
      ],
      jump: { matches: [true, true, false], labels: ['a', 's', null], typed: 't' },
    }),
    { cols: 120, rows: 30 },
  );

  const text = renderPanelText(plan);

  expect({
    names: [text[1]?.slice(5, 9), text[2]?.slice(5, 9), text[3]?.slice(5, 9)],
    faded: plan.content.map((line) => line.isFaded),
  }).toStrictEqual({ names: ['tai ', 'cats', 'web '], faded: [false, false, true] });
});

test('it leaves the state glyph on each row while jump mode runs', () => {
  const plan = buildListPanel(
    buildMockPanelInput({
      rows: [{ kind: 'session', session: buildMockMirrorSession({ name: 'api' }), via: null }],
      jump: { matches: [true], labels: [null], typed: '' },
    }),
    { cols: 120, rows: 30 },
  );

  expect(renderPanelText(plan)[1]?.slice(2, 4)).toMatch(/^▎[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/u);
});

test('it drops the age and shortens the name of a row in a 14-column window', () => {
  const plan = buildListPanel(
    buildMockPanelInput({
      rows: [
        {
          kind: 'session',
          session: buildMockMirrorSession({ name: 'abcdefgh', state: 'done', stateSince: 0 }),
          via: null,
        },
      ],
      selected: 0,
      nowMs: 120_000,
    }),
    { cols: 14, rows: 20 },
  );

  expect(renderPanelText(plan)[1]).toBe('│ ▌✓ abcd…   │');
});

test.each([
  { typed: 'st', expected: ['İ', 'st', 'anbul'] },
  { typed: 'i', expected: ['', 'İ', 'stanbul'] },
  { typed: 'AN', expected: ['İst', 'an', 'bul'] },
])('it highlights the letters of İstanbul that jump mode matched with $typed', (row) => {
  const plan = buildListPanel(
    buildMockPanelInput({
      rows: [{ kind: 'session', session: buildMockMirrorSession({ name: 'İstanbul' }), via: null }],
      selected: 0,
      jump: { matches: [true], labels: [null], typed: row.typed },
    }),
    { cols: 120, rows: 20 },
  );

  const nameSpans = plan.content[0]?.spans.slice(4, 7) ?? [];

  expect(nameSpans.map((span) => [span.text.trimEnd(), span.fg === BLUE])).toStrictEqual([
    [row.expected[0], false],
    [row.expected[1], true],
    [row.expected[2], false],
  ]);
});

test.each([
  {
    size: { cols: 32, rows: 10 },
    prompt:
      'end builder? stops the agent and deletes its sprite machine, with every session on it, and removes its 3 ended sub-sessions · y / n',
    expected: { bottomRow: 8, hasKeys: true, hasAction: true },
  },
  {
    size: { cols: 40, rows: 4 },
    prompt: 'kill s0? · y / n',
    expected: { bottomRow: 2, hasKeys: true, hasAction: true },
  },
  {
    size: { cols: 24, rows: 4 },
    prompt: 'end builder? stops the agent and deletes its sprite machine · y / n',
    expected: { bottomRow: 2, hasKeys: true, hasAction: false },
  },
])('it keeps a prompt above the fleet bar in a $size.cols x $size.rows window', (row) => {
  const rows = Array.from({ length: 3 }, () => ({
    kind: 'session' as const,
    session: buildMockMirrorSession(),
    via: null,
  }));

  const plan = buildListPanel(buildMockPanelInput({ rows, selected: 0, prompt: row.prompt }), {
    cols: row.size.cols,
    rows: row.size.rows,
  });

  const text = renderPanelText(plan);

  expect({
    bottomRow: plan.top + text.length - 1,
    hasKeys: text.join('\n').includes('y / n'),
    hasAction: text.join('\n').includes(row.prompt.split('?')[0] ?? ''),
  }).toStrictEqual(row.expected);
});

test.each([
  { rows: 5, expected: ['╭─ 3 session', '├───────────', '│ kill s0? ·', '╰───────────'] },
  { rows: 4, expected: ['╭─ 3 session', '│ kill s0? ·', '╰───────────'] },
  { rows: 3, expected: ['╭─ 3 session', '│ kill s0? ·'] },
])('it drops the list lines, then the borders, for a prompt in $rows rows', (row) => {
  const rows = Array.from({ length: 3 }, () => ({
    kind: 'session' as const,
    session: buildMockMirrorSession(),
    via: null,
  }));

  const plan = buildListPanel(
    buildMockPanelInput({ rows, selected: 0, prompt: 'kill s0? · y / n' }),
    { cols: 40, rows: row.rows },
  );

  expect(renderPanelText(plan).map((line) => line.slice(0, 12))).toStrictEqual([...row.expected]);
});

test('it wraps a prompt over lines so the keys that confirm it still show', () => {
  const plan = buildListPanel(
    buildMockPanelInput({
      prompt:
        'end orchard-inventory-and-shipping-review? stops the agent and deletes its sprite machine, with every session on it · y / n',
    }),
    { cols: 80, rows: 30 },
  );

  const text = renderPanelText(plan).join('\n');

  expect(text).toInclude('· y / n');
  expect(text).toInclude('deletes its sprite machine');
});
