import { expect, test } from 'bun:test';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { collectListRows } from './collect-list-rows';
import type { ListRowOptions } from './collect-list-rows';

test.each([
  {
    title: 'flat mode with no headers, in state order',
    options: { grouping: 'flat', filter: null, daemons: [null] } satisfies ListRowOptions,
    sessions: [
      { id: 'a', name: 'done-one', state: 'done', lastAttachedAt: 5 },
      { id: 'b', name: 'needy', state: 'needs_you', lastAttachedAt: 1 },
      { id: 'c', name: 'dead', state: 'exited', lastAttachedAt: 9 },
      { id: 'd', name: 'busy', state: 'running', lastAttachedAt: 2 },
    ],
    expected: ['needy', 'done-one', 'busy', 'dead'],
  },
  {
    title: 'flat mode with a sub-session under its parent',
    options: { grouping: 'flat', filter: null, daemons: [null] } satisfies ListRowOptions,
    sessions: [
      { id: 'p', name: 'parent', lastAttachedAt: 1 },
      { id: 'o', name: 'other', lastAttachedAt: 9 },
      { id: 'c', name: 'child', parent: 'p', lastAttachedAt: 8 },
    ],
    expected: ['other', 'parent', 'child'],
  },
  {
    title: 'repo mode with pinned sessions in a group above the others',
    options: { grouping: 'repo', filter: null, daemons: [null] } satisfies ListRowOptions,
    sessions: [
      { id: 'a', name: 'shop-one', repoRoot: '/work/shop', state: 'needs_you' },
      { id: 'b', name: 'kite-pin', repoRoot: '/work/kite', pinned: true, state: 'exited' },
      { id: 'c', name: 'shop-two', repoRoot: '/work/shop', state: 'running' },
    ],
    expected: ['# pinned 1 0', 'kite-pin', '# shop 2 1', 'shop-one', 'shop-two'],
  },
  {
    title: 'repo mode with a sub-session in its parent group',
    options: { grouping: 'repo', filter: null, daemons: [null] } satisfies ListRowOptions,
    sessions: [
      { id: 'p', name: 'parent', repoRoot: '/work/shop', lastAttachedAt: 1 },
      { id: 'c', name: 'child', parent: 'p', repoRoot: '/work/kite', lastAttachedAt: 1 },
    ],
    expected: ['# shop 2 0', 'parent', 'child'],
  },
  {
    title: 'repo mode with the daemon name on two folders of one name',
    options: { grouping: 'repo', filter: null, daemons: [null, 'box'] } satisfies ListRowOptions,
    sessions: [
      { id: 'a', name: 'here', daemon: null, repoRoot: '/home/a/shop' },
      { id: 'b', name: 'there', daemon: 'box', repoRoot: '/srv/shop' },
    ],
    expected: ['# shop · box 1 0', 'there', '# shop · local 1 0', 'here'],
  },
  {
    title: 'place mode with via on the rows of a group that holds two daemons',
    options: { grouping: 'place', filter: null, daemons: [null, 'box'] } satisfies ListRowOptions,
    sessions: [
      {
        id: 'a',
        name: 'api',
        daemon: null,
        place: { key: 'sprite-key', label: 'sprite' },
        lastAttachedAt: 3,
      },
      {
        id: 'b',
        name: 'app',
        daemon: 'box',
        place: { key: 'sprite-key', label: 'sprite' },
        lastAttachedAt: 2,
      },
      {
        id: 'c',
        name: 'web',
        daemon: null,
        place: { key: 'laptop-key', label: 'laptop' },
        lastAttachedAt: 1,
      },
    ],
    expected: ['# sprite 2 0', 'api via local', 'app via box', '# laptop 1 0', 'web'],
  },
  {
    title: 'place mode with no via on a group of one daemon',
    options: { grouping: 'place', filter: null, daemons: [null] } satisfies ListRowOptions,
    sessions: [{ id: 'a', name: 'api', place: { key: 'sprite-key', label: 'sprite' } }],
    expected: ['# sprite 1 0', 'api'],
  },
  {
    title: 'place mode with a group that holds a session in needs_you',
    options: { grouping: 'place', filter: null, daemons: [null] } satisfies ListRowOptions,
    sessions: [
      { id: 'a', name: 'calm', place: { key: 'sprite-key', label: 'sprite' }, state: 'running' },
      { id: 'b', name: 'ask', place: { key: 'sprite-key', label: 'sprite' }, state: 'needs_you' },
    ],
    expected: ['# sprite 2 1', 'ask', 'calm'],
  },
  {
    title: 'two groups ordered by their first session, then by label',
    options: { grouping: 'place', filter: null, daemons: [null] } satisfies ListRowOptions,
    sessions: [
      {
        id: 'a',
        name: 'quiet',
        place: { key: 'laptop-key', label: 'laptop' },
        state: 'running',
        lastAttachedAt: 1,
      },
      {
        id: 'b',
        name: 'loud',
        place: { key: 'sprite-key', label: 'sprite' },
        state: 'needs_you',
        lastAttachedAt: 1,
      },
    ],
    expected: ['# sprite 1 1', 'loud', '# laptop 1 0', 'quiet'],
  },
  {
    title: 'a filter that keeps the parent of a matching child',
    options: { grouping: 'flat', filter: 'kid', daemons: [null] } satisfies ListRowOptions,
    sessions: [
      { id: 'p', name: 'parent' },
      { id: 'c', name: 'kid', parent: 'p' },
      { id: 'o', name: 'other' },
    ],
    expected: ['parent', 'kid'],
  },
  {
    title: 'one session id on two daemons, each with its own child',
    options: { grouping: 'flat', filter: null, daemons: [null, 'box'] } satisfies ListRowOptions,
    sessions: [
      { id: 'p', name: 'near', daemon: null, lastAttachedAt: 2 },
      { id: 'p', name: 'far', daemon: 'box', lastAttachedAt: 1 },
      { id: 'c', name: 'far-child', daemon: 'box', parent: 'p', lastAttachedAt: 5 },
    ],
    expected: ['near', 'far', 'far-child'],
  },
  {
    title: 'repo mode with a grandchild in the group of its family root',
    options: { grouping: 'repo', filter: null, daemons: [null] } satisfies ListRowOptions,
    sessions: [
      { id: 'one', name: 'root', repoRoot: '/work/shop' },
      { id: 'two', name: 'child', parent: 'one', repoRoot: '/work/kite' },
      { id: 'three', name: 'grandchild', parent: 'two', repoRoot: '/work/kite' },
    ],
    expected: ['# shop 3 0', 'root', 'child', 'grandchild'],
  },
  {
    title: 'flat mode with two sessions whose parents point at each other',
    options: { grouping: 'flat', filter: null, daemons: [null] } satisfies ListRowOptions,
    sessions: [
      { id: 'one', name: 'first', parent: 'two', lastAttachedAt: 3 },
      { id: 'two', name: 'second', parent: 'one', lastAttachedAt: 2 },
      { id: 'three', name: 'third', lastAttachedAt: 1 },
    ],
    expected: ['first', 'second', 'third'],
  },
  {
    title: 'repo mode with the parent folder on two roots of one folder name on one daemon',
    options: { grouping: 'repo', filter: null, daemons: [null] } satisfies ListRowOptions,
    sessions: [
      { id: 'a', name: 'one', repoRoot: '/work/first/shop', lastAttachedAt: 2 },
      { id: 'b', name: 'two', repoRoot: '/work/second/shop', lastAttachedAt: 1 },
    ],
    expected: ['# shop · local · first 1 0', 'one', '# shop · local · second 1 0', 'two'],
  },
  {
    title: 'place mode with a qualified label that another place holds as its own',
    options: { grouping: 'place', filter: null, daemons: ['lab', 'box'] } satisfies ListRowOptions,
    sessions: [
      {
        id: 'one',
        name: 'first',
        daemon: 'lab',
        target: 'vm',
        place: { key: 'one', label: 'cloud' },
        lastAttachedAt: 3,
      },
      {
        id: 'two',
        name: 'second',
        daemon: 'box',
        target: 'vm',
        place: { key: 'two', label: 'cloud' },
        lastAttachedAt: 2,
      },
      {
        id: 'three',
        name: 'third',
        daemon: 'lab',
        target: 'vm',
        place: { key: 'three', label: 'cloud · lab' },
        lastAttachedAt: 1,
      },
    ],
    expected: [
      '# cloud · lab · vm 1 0',
      'first',
      '# cloud · box 1 0',
      'second',
      '# cloud · lab · lab 1 0',
      'third',
    ],
  },
])('#collectListRows gives $title', (row) => {
  const sessions = row.sessions.map((overrides) =>
    buildMockMirrorSession({
      cwd: '/work/shop',
      repoRoot: '/work/shop',
      state: 'running',
      createdAt: 0,
      lastAttachedAt: 0,
      ...overrides,
    }),
  );

  const lines = collectListRows(sessions, row.options).map((listed) => {
    if (listed.kind === 'header') {
      return `# ${listed.label} ${listed.count} ${listed.needYou}`;
    }

    return listed.via === null ? listed.session.name : `${listed.session.name} via ${listed.via}`;
  });

  expect(lines).toStrictEqual([...row.expected]);
});
