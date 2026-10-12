import { expect, test } from 'bun:test';
import { DaemonClient } from '../client/daemon-client';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { buildStubFleetCaller } from '../test-utils/build-stub-fleet-caller';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { readNoteTexts } from './read-note-texts';
import { ReconnectingCaller } from './reconnecting-caller';

// A daemon that holds no note and a caller connected to it.
async function setupTest() {
  const daemon = await startTestDaemon({ prefix: 'atc-read-note-texts-' });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  return { caller };
}

test('it adds the whole text of each note to its event and passes the rest of the page through', async () => {
  const texts: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    c1: { text: 'whole one', complete: true },
    'pc.0a1b2c3d.c3': { text: 'preview only', complete: false },
  };

  const caller = buildStubFleetCaller({
    answer: (request) => texts[String(request.p?.['note'])] ?? {},
  });

  const page = await readNoteTexts(caller, {
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'note',
        detail: 'whole',
        label: 'l',
      },
      { cursor: 'c2', at: 2, session: 's2', name: 'two', kind: 'turn-done', detail: null },
      {
        cursor: 'c3',
        at: 3,
        session: 's2',
        name: 'two',
        kind: 'note',
        detail: 'preview only',
        label: 'l',
        note: 'pc.0a1b2c3d.c3',
      },
    ],
    cursor: 'c3',
    more: false,
    unavailable: ['cloud'],
    started: ['pc'],
    truncated: ['pc'],
  });

  expect(page).toStrictEqual({
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'note',
        detail: 'whole',
        label: 'l',
        text: 'whole one',
        complete: true,
      },
      { cursor: 'c2', at: 2, session: 's2', name: 'two', kind: 'turn-done', detail: null },
      {
        cursor: 'c3',
        at: 3,
        session: 's2',
        name: 'two',
        kind: 'note',
        detail: 'preview only',
        label: 'l',
        note: 'pc.0a1b2c3d.c3',
        text: 'preview only',
        complete: false,
      },
    ],
    cursor: 'c3',
    more: false,
    unavailable: ['cloud'],
    started: ['pc'],
    truncated: ['pc'],
  });

  expect(caller.requests).toStrictEqual([
    { m: 'note.get', p: { note: 'c1' }, required: ['note.get'] },
    { m: 'note.get', p: { note: 'pc.0a1b2c3d.c3' }, required: ['note.get'] },
  ]);
});

test('it stops the page before the first note whose text would carry it past 64 KiB', async () => {
  const texts: Readonly<Record<string, string>> = {
    c1: 'a'.repeat(40_000),
    c2: 'b'.repeat(25_536),
    c4: 'c',
  };

  const caller = buildStubFleetCaller({
    answer: (request) => ({ text: texts[String(request.p?.['note'])], complete: true }),
  });

  const page = await readNoteTexts(caller, {
    events: [
      { cursor: 'c1', at: 1, session: 's1', name: null, kind: 'note', detail: 'a', label: 'l' },
      { cursor: 'c2', at: 2, session: 's2', name: null, kind: 'note', detail: 'b', label: 'l' },
      { cursor: 'c3', at: 3, session: 's2', name: null, kind: 'turn-done', detail: null },
      { cursor: 'c4', at: 4, session: 's1', name: null, kind: 'note', detail: 'c', label: 'l' },
      { cursor: 'c5', at: 5, session: 's1', name: null, kind: 'turn-done', detail: null },
    ],
    cursor: 'c5',
    more: false,
  });

  expect(page).toStrictEqual({
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'note',
        detail: 'a',
        label: 'l',
        text: 'a'.repeat(40_000),
        complete: true,
      },
      {
        cursor: 'c2',
        at: 2,
        session: 's2',
        name: null,
        kind: 'note',
        detail: 'b',
        label: 'l',
        text: 'b'.repeat(25_536),
        complete: true,
      },
      { cursor: 'c3', at: 3, session: 's2', name: null, kind: 'turn-done', detail: null },
    ],
    cursor: 'c3',
    more: true,
  });

  expect(caller.requests).toStrictEqual([
    { m: 'note.get', p: { note: 'c1' }, required: ['note.get'] },
    { m: 'note.get', p: { note: 'c2' }, required: ['note.get'] },
    { m: 'note.get', p: { note: 'c4' }, required: ['note.get'] },
  ]);
});

test('it keeps a note whose text read fails with its preview and the refusal', async () => {
  const ctx = await setupTest();

  const page = await readNoteTexts(ctx.caller, {
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'note',
        detail: 'gone',
        label: 'l',
      },
    ],
    cursor: 'c1',
    more: false,
  });

  expect(page).toStrictEqual({
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'note',
        detail: 'gone',
        label: 'l',
        textError: "bad_args: no note 'c1'",
      },
    ],
    cursor: 'c1',
    more: false,
  });
});

test('it gives a note whose text read outlasts the deadline a timeout and stops the page after it', async () => {
  const clock = buildStubClock(0);

  const caller = buildStubFleetCaller({
    answer: () => Promise.withResolvers<Readonly<Record<string, unknown>>>().promise,
  });

  const reading = readNoteTexts(
    caller,
    {
      events: [
        {
          cursor: 'c1',
          at: 1,
          session: 's1',
          name: null,
          kind: 'note',
          detail: 'slow',
          label: 'l',
        },
        { cursor: 'c2', at: 2, session: 's2', name: null, kind: 'turn-done', detail: null },
        {
          cursor: 'c3',
          at: 3,
          session: 's1',
          name: null,
          kind: 'note',
          detail: 'next',
          label: 'l',
        },
      ],
      cursor: 'c3',
      more: false,
    },
    100,
    clock,
  );

  clock.advance(100);

  const page = await reading;

  expect(caller.requests).toStrictEqual([
    { m: 'note.get', p: { note: 'c1' }, required: ['note.get'] },
  ]);

  expect(page).toStrictEqual({
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'note',
        detail: 'slow',
        label: 'l',
        textError: 'timeout: the note text did not arrive within 100 ms',
      },
      { cursor: 'c2', at: 2, session: 's2', name: null, kind: 'turn-done', detail: null },
    ],
    cursor: 'c2',
    more: true,
  });
});

test('it keeps a note text that arrives just inside the deadline', () => {
  const clock = buildStubClock(0);
  const held = Promise.withResolvers<Readonly<Record<string, unknown>>>();
  const caller = buildStubFleetCaller({ answer: () => held.promise });

  const reading = readNoteTexts(
    caller,
    {
      events: [
        {
          cursor: 'c1',
          at: 1,
          session: 's1',
          name: null,
          kind: 'note',
          detail: 'slow',
          label: 'l',
        },
      ],
      cursor: 'c1',
      more: false,
    },
    100,
    clock,
  );

  clock.advance(99);
  held.resolve({ text: 'in time', complete: true });

  expect(reading).resolves.toStrictEqual({
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'note',
        detail: 'slow',
        label: 'l',
        text: 'in time',
        complete: true,
      },
    ],
    cursor: 'c1',
    more: false,
  });
});
