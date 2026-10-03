import { expect, test } from 'bun:test';
import { toSessionID } from '../shared/to-session-id';
import { buildSessionReportEvent } from './build-session-report-event';

test('it builds a report event carrying the note label as its kind', () => {
  const event = buildSessionReportEvent(
    toSessionID('s1'),
    { kind: 'note', label: 'blocked', text: 'need review' },
    1000,
  );

  expect(event).toStrictEqual({
    v: 4,
    ev: 'SessionReport',
    s: 's1',
    kind: 'blocked',
    text: 'need review',
    reportedAt: 1000,
  });
});
