import { expect, test } from 'bun:test';
import { pickTestWorkers } from './pick-test-workers';

test.each([
  ['1 CPU and 16 GiB', 1, 16 * 1024 ** 3, 1],
  ['2 CPUs and 16 GiB', 2, 16 * 1024 ** 3, 1],
  ['8 CPUs and 2 GiB', 8, 2 * 1024 ** 3, 1],
  ['8 CPUs and the 1989 MiB a 2 GiB VM reports', 8, 1989 * 1024 ** 2, 1],
  ['3 CPUs and 2 GiB plus one byte', 3, 2 * 1024 ** 3 + 1, 3],
  ['8 CPUs and 16 GiB', 8, 16 * 1024 ** 3, 8],
])('it picks for a host with %s', (_label, cpus, memoryBytes, expected) => {
  expect(pickTestWorkers({ cpus, memoryBytes })).toBe(expected);
});
