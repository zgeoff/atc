import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { buildMockSession } from '../test-utils/build-mock-session';
import { collectFateReads } from './collect-fate-reads';

test('it collects one read for each host that holds sleeping sessions', () => {
  const first = buildMockSession({
    id: toSessionID('s-1'),
    hostKey: toSessionID('h-1'),
    target: 'box',
    suspended: true,
    state: 'exited',
    pty: null,
  });

  const second = buildMockSession({
    id: toSessionID('s-2'),
    hostKey: toSessionID('h-1'),
    target: 'box',
    suspended: true,
    state: 'exited',
    pty: null,
  });

  const other = buildMockSession({
    id: toSessionID('s-3'),
    hostKey: toSessionID('h-3'),
    target: 'box',
    suspended: true,
    state: 'exited',
    pty: null,
  });

  expect(collectFateReads([first, second, other], {})).toStrictEqual([
    { target: 'box', hostKey: toSessionID('h-1'), sessions: [first, second] },
    { target: 'box', hostKey: toSessionID('h-3'), sessions: [other] },
  ]);
});

test('it leaves out a session that is not asleep', () => {
  const running = buildMockSession({
    id: toSessionID('s-1'),
    hostKey: toSessionID('h-1'),
    suspended: false,
    state: 'running',
    pty: null,
  });

  expect(collectFateReads([running], {})).toStrictEqual([]);
});

test('it collects only the host of the scope, without the session it leaves out', () => {
  const kept = buildMockSession({
    id: toSessionID('s-1'),
    hostKey: toSessionID('h-1'),
    target: 'box',
    suspended: true,
    state: 'exited',
    pty: null,
  });

  const left = buildMockSession({
    id: toSessionID('s-2'),
    hostKey: toSessionID('h-1'),
    target: 'box',
    suspended: true,
    state: 'exited',
    pty: null,
  });

  const elsewhere = buildMockSession({
    id: toSessionID('s-3'),
    hostKey: toSessionID('h-3'),
    target: 'box',
    suspended: true,
    state: 'exited',
    pty: null,
  });

  expect(
    collectFateReads([kept, left, elsewhere], { hostKey: toSessionID('h-1'), except: left.id }),
  ).toStrictEqual([{ target: 'box', hostKey: toSessionID('h-1'), sessions: [kept] }]);
});
