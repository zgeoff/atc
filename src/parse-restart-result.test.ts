import { expect, test } from 'bun:test';
import { parseRestartResult } from './parse-restart-result';

test('it reads a result record from a line of JSON', () => {
  const line =
    '{"runID":"r1","code":0,"pid":9,"build":"atc/x","listenPort":null,"restored":1,"total":1,"failed":[],"interrupted":[],"error":null}';

  expect(parseRestartResult(line)).toStrictEqual({
    runID: 'r1',
    code: 0,
    pid: 9,
    build: 'atc/x',
    listenPort: null,
    restored: 1,
    total: 1,
    failed: [],
    interrupted: [],
    error: null,
  });
});

test('it reads null for a log line that is not a result record', () => {
  expect(parseRestartResult('worker pid 12')).toBeNull();
});

test('it reads null for JSON that lacks the record fields', () => {
  expect(parseRestartResult('{"runID":"r1"}')).toBeNull();
});
