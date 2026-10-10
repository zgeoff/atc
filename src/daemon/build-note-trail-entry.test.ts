import { expect, test } from 'bun:test';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { buildNoteTrailEntry } from './build-note-trail-entry';

test('it builds a note entry carrying the note label and a text preview', () => {
  const entry = buildNoteTrailEntry(
    toSessionID('s1'),
    toAgentSessionID('c1'),
    { kind: 'note', label: 'blocked', text: 'need review' },
    1000,
  );

  expect(entry).toStrictEqual({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'note',
    label: 'blocked',
    detail: 'need review',
    text: 'need review',
  });
});

test('it holds no agent session id for a session that has not reported one', () => {
  const entry = buildNoteTrailEntry(
    toSessionID('s1'),
    undefined,
    { kind: 'note', label: 'blocked', text: 'need review' },
    1000,
  );

  expect(entry).toStrictEqual({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'note',
    label: 'blocked',
    detail: 'need review',
    text: 'need review',
  });
});

test('it keeps the whole text beside a preview cut at 600 characters', () => {
  const entry = buildNoteTrailEntry(
    toSessionID('s1'),
    undefined,
    { kind: 'note', label: 'decision', text: 'x'.repeat(700) },
    1000,
  );

  expect(entry).toStrictEqual({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'note',
    label: 'decision',
    detail: `${'x'.repeat(599)}…`,
    text: 'x'.repeat(700),
  });
});
