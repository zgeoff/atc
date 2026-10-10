import { expect, test } from 'bun:test';
import { toSessionID } from '../shared/to-session-id';
import { buildSessionNoteEvent } from './build-session-note-event';

test('it builds a note event carrying the note label as its kind', () => {
  const event = buildSessionNoteEvent(
    toSessionID('s1'),
    { kind: 'note', label: 'blocked', text: 'need review' },
    1000,
  );

  expect(event).toStrictEqual({
    v: 4,
    ev: 'SessionNote',
    s: 's1',
    kind: 'blocked',
    text: 'need review',
    sentAt: 1000,
  });
});
