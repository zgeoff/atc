import { expect, test } from 'bun:test';
import { DaemonError } from '../protocol/daemon-error';
import { DAEMON_FEATURES } from '../protocol/daemon-features';
import { readReportTexts } from './read-report-texts';

test('it adds the whole text of each report to its event and passes the rest of the page through', async () => {
  const sent: unknown[] = [];

  const texts: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    c1: { text: 'whole one', complete: true },
    'pc.0a1b2c3d.c3': { text: 'preview only', complete: false },
  };

  const page = await readReportTexts(
    {
      sendRequest: (m, p, required) => {
        sent.push({ m, p, required });

        return Promise.resolve(texts[String(p?.['report'])] ?? {});
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    {
      events: [
        {
          cursor: 'c1',
          at: 1,
          session: 's1',
          name: null,
          kind: 'report',
          detail: 'whole',
          label: 'l',
        },
        { cursor: 'c2', at: 2, session: 's2', name: 'two', kind: 'turn-done', detail: null },
        {
          cursor: 'c3',
          at: 3,
          session: 's2',
          name: 'two',
          kind: 'report',
          detail: 'preview only',
          label: 'l',
          report: 'pc.0a1b2c3d.c3',
        },
      ],
      cursor: 'c3',
      more: false,
      unavailable: ['cloud'],
      started: ['pc'],
      truncated: ['pc'],
    },
  );

  expect(page).toStrictEqual({
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'report',
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
        kind: 'report',
        detail: 'preview only',
        label: 'l',
        report: 'pc.0a1b2c3d.c3',
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

  expect(sent).toStrictEqual([
    { m: 'report.get', p: { report: 'c1' }, required: ['report.get'] },
    { m: 'report.get', p: { report: 'pc.0a1b2c3d.c3' }, required: ['report.get'] },
  ]);
});

test('it stops the page before the first report whose text would carry it past 64 KiB', async () => {
  const sent: unknown[] = [];

  const texts: Readonly<Record<string, string>> = {
    c1: 'a'.repeat(40_000),
    c2: 'b'.repeat(25_536),
    c4: 'c',
  };

  const page = await readReportTexts(
    {
      sendRequest: (_method, p) => {
        sent.push(p?.['report']);

        return Promise.resolve({ text: texts[String(p?.['report'])], complete: true });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    {
      events: [
        { cursor: 'c1', at: 1, session: 's1', name: null, kind: 'report', detail: 'a', label: 'l' },
        { cursor: 'c2', at: 2, session: 's2', name: null, kind: 'report', detail: 'b', label: 'l' },
        { cursor: 'c3', at: 3, session: 's2', name: null, kind: 'turn-done', detail: null },
        { cursor: 'c4', at: 4, session: 's1', name: null, kind: 'report', detail: 'c', label: 'l' },
        { cursor: 'c5', at: 5, session: 's1', name: null, kind: 'turn-done', detail: null },
      ],
      cursor: 'c5',
      more: false,
    },
  );

  expect(page).toStrictEqual({
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'report',
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
        kind: 'report',
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

  expect(sent).toStrictEqual(['c1', 'c2', 'c4']);
});

test('it keeps a report whose text read fails with its preview and the refusal', async () => {
  const page = await readReportTexts(
    {
      sendRequest: (_method, p) =>
        Promise.reject(new DaemonError('bad_args', `no report '${String(p?.['report'])}'`)),
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    {
      events: [
        {
          cursor: 'c1',
          at: 1,
          session: 's1',
          name: null,
          kind: 'report',
          detail: 'gone',
          label: 'l',
        },
      ],
      cursor: 'c1',
      more: false,
    },
  );

  expect(page).toStrictEqual({
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'report',
        detail: 'gone',
        label: 'l',
        textError: "bad_args: no report 'c1'",
      },
    ],
    cursor: 'c1',
    more: false,
  });
});

test('it gives a report whose text read outlasts the deadline a timeout and stops the page after it', async () => {
  const sent: unknown[] = [];
  const started = Date.now();

  const page = await readReportTexts(
    {
      sendRequest: (_method, p) => {
        sent.push(p?.['report']);

        return Promise.withResolvers<Readonly<Record<string, unknown>>>().promise;
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    {
      events: [
        {
          cursor: 'c1',
          at: 1,
          session: 's1',
          name: null,
          kind: 'report',
          detail: 'slow',
          label: 'l',
        },
        { cursor: 'c2', at: 2, session: 's2', name: null, kind: 'turn-done', detail: null },
        {
          cursor: 'c3',
          at: 3,
          session: 's1',
          name: null,
          kind: 'report',
          detail: 'next',
          label: 'l',
        },
      ],
      cursor: 'c3',
      more: false,
    },
    100,
  );

  expect(Date.now() - started).toBeWithin(100, 2000);
  expect(sent).toStrictEqual(['c1']);

  expect(page).toStrictEqual({
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'report',
        detail: 'slow',
        label: 'l',
        textError: 'timeout: the report text did not arrive within 100 ms',
      },
      { cursor: 'c2', at: 2, session: 's2', name: null, kind: 'turn-done', detail: null },
    ],
    cursor: 'c2',
    more: true,
  });
});
