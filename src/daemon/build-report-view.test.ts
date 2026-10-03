import { expect, test } from 'bun:test';
import { decodeCursor } from '../protocol/decode-cursor';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toDaemonID } from '../shared/to-daemon-id';
import { toSessionID } from '../shared/to-session-id';
import { buildReportView } from './build-report-view';

test('it names a report by the live session holding its agent session id', () => {
  const sessions = [
    {
      id: toSessionID('s-new'),
      name: 'worker',
      cwd: '/tmp',
      state: 'done' as const,
      unread: false,
      lastMsg: 'turn done',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      pinned: false,
      lastAttachedAt: 1,
      repoRoot: '/tmp',
      namedBy: 'user' as const,
      createdAt: 1,
      kind: 'pty' as const,
      alive: true,
      canEject: false,
      locator: { daemonID: toDaemonID('d-1'), targetID: 'local' },
      lifecycle: {
        desired: 'run' as const,
        vm: 'none' as const,
        harness: 'running' as const,
        attachment: 'local' as const,
      },
    },
  ];

  const view = buildReportView(
    {
      id: 7,
      at: 1000,
      atcID: toSessionID('s-old'),
      agentSessionID: toAgentSessionID('c1'),
      label: 'decision',
      text: 'pick one',
      complete: true,
    },
    sessions,
    sessions,
  );

  expect({ ...view, report: decodeCursor(view.report) }).toStrictEqual({
    report: { kind: 'events', id: 7 },
    at: 1000,
    session: 's-new',
    name: 'worker',
    label: 'decision',
    text: 'pick one',
    complete: true,
  });
});

test('it holds no name for a report of a session no longer listed', () => {
  const view = buildReportView(
    {
      id: 7,
      at: 1000,
      atcID: toSessionID('s-gone'),
      agentSessionID: null,
      label: 'decision',
      text: 'pick one',
      complete: true,
    },
    [],
    [],
  );

  expect(view).toMatchObject({ session: 's-gone', name: null });
});

test('it keeps a report on its own atc id when it may take no alias', () => {
  const view = buildReportView(
    {
      id: 7,
      at: 1000,
      atcID: toSessionID('s-hidden'),
      agentSessionID: toAgentSessionID('c1'),
      label: 'decision',
      text: 'pick one',
      complete: true,
    },
    [
      {
        id: toSessionID('s-shown'),
        name: 'worker',
        cwd: '/tmp',
        state: 'done',
        unread: false,
        lastMsg: 'turn done',
        agentSessionID: toAgentSessionID('c1'),
        agent: 'claude',
        pinned: false,
        lastAttachedAt: 1,
        repoRoot: '/tmp',
        namedBy: 'user',
        createdAt: 1,
        kind: 'pty',
        alive: true,
        canEject: false,
        locator: { daemonID: toDaemonID('d-1'), targetID: 'local' },
        lifecycle: { desired: 'run', vm: 'none', harness: 'running', attachment: 'local' },
      },
    ],
    [],
  );

  expect(view).toMatchObject({ session: 's-hidden', name: null });
});
