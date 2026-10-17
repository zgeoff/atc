import { expect, onTestFinished, test } from 'bun:test';
import { configure, getLogger, reset } from '@logtape/logtape';
import type { LogRecord } from '@logtape/logtape';
import { formatLogLine } from './format-log-line';

async function setupTest() {
  const records: LogRecord[] = [];

  await configure({
    sinks: {
      kept: (record) => {
        records.push(record);
      },
    },
    loggers: [
      { category: ['atc'], sinks: ['kept'], lowestLevel: 'info' },
      { category: ['logtape', 'meta'], sinks: [] },
    ],
  });

  onTestFinished(() => reset());

  return { records };
}

test.each([
  'atc tcp event=listening host=127.0.0.1 port=8415',
  'atc tcp event=handshake_refused peer=100.64.0.7 reason=unauthorized count=1',
  'atc tcp event=principal_refused peer=100.64.0.7 principal=unlisted count=1',
  'atc tcp event=refused peer=overflow count=1',
  'atc tcp event=listening host={braced} port=0',
])('it writes the line %p as it went in, with a newline', async (line) => {
  const ctx = await setupTest();

  getLogger(['atc', 'tcp']).info('{line}', { line });

  expect(ctx.records.map((record) => formatLogLine(record))).toStrictEqual([`${line}\n`]);
});

test('it writes each value of a template as a string', async () => {
  const ctx = await setupTest();

  getLogger(['atc', 'tcp']).info('atc tcp event=refused peer={peer} count={count}', {
    peer: 'overflow',
    count: 3,
  });

  expect(ctx.records.map((record) => formatLogLine(record))).toStrictEqual([
    'atc tcp event=refused peer=overflow count=3\n',
  ]);
});
