import { expect, test } from 'bun:test';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { buildReportTrailEntry } from './build-report-trail-entry';

test('it builds a report entry carrying the note label and a text preview', () => {
  const entry = buildReportTrailEntry(
    toSessionID('s1'),
    toAgentSessionID('c1'),
    { kind: 'note', label: 'blocked', text: 'need review' },
    1000,
  );

  expect(entry).toStrictEqual({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'report',
    label: 'blocked',
    detail: 'need review',
  });
});

test('it holds no agent session id for a session that has not reported one', () => {
  const entry = buildReportTrailEntry(
    toSessionID('s1'),
    undefined,
    { kind: 'note', label: 'blocked', text: 'need review' },
    1000,
  );

  expect(entry).toStrictEqual({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'report',
    label: 'blocked',
    detail: 'need review',
  });
});
