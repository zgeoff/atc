import { expect, test } from 'bun:test';
import { parseWorkerPID } from './parse-worker-pid';

test('it reads the pid a worker record holds', () => {
  expect(parseWorkerPID('{"workerPID":4242}')).toBe(4242);
});

test.each([
  ['a progress line', 'stopped the daemon (pid 12)'],
  ['a result record', '{"runID":"r1","code":0}'],
  ['a record with a pid that is not a number', '{"workerPID":"12"}'],
  ['a record with more than the pid', '{"workerPID":12,"runID":"r1"}'],
])('it reads null for %s', (_label, line) => {
  expect(parseWorkerPID(line)).toBeNull();
});
