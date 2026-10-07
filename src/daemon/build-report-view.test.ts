import { expect, test } from 'bun:test';
import { decodeCursor } from '../protocol/decode-cursor';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { buildMockSessionDescriptor } from '../test-utils/build-mock-session-descriptor';
import { buildReportView } from './build-report-view';

test('it names a report by the live session holding its agent session id', () => {
  const sessions = [
    buildMockSessionDescriptor({
      id: toSessionID('s-new'),
      name: 'worker',
      agentSessionID: toAgentSessionID('c1'),
    }),
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

  expect({ ...view, report: decodeCursor(view.report) }).toStrictEqual({
    report: { kind: 'events', id: 7 },
    at: 1000,
    session: 's-gone',
    name: null,
    label: 'decision',
    text: 'pick one',
    complete: true,
  });
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
      buildMockSessionDescriptor({
        id: toSessionID('s-shown'),
        name: 'worker',
        agentSessionID: toAgentSessionID('c1'),
      }),
    ],
    [],
  );

  expect({ ...view, report: decodeCursor(view.report) }).toStrictEqual({
    report: { kind: 'events', id: 7 },
    at: 1000,
    session: 's-hidden',
    name: null,
    label: 'decision',
    text: 'pick one',
    complete: true,
  });
});
