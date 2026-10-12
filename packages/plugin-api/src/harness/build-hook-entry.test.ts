import { expect, test } from 'bun:test';
import { buildHookEntry } from './build-hook-entry';

test('it runs the command with the timeout it is given', () => {
  expect(buildHookEntry('"atc" hook-report', 5)).toStrictEqual({
    hooks: [{ type: 'command', command: '"atc" hook-report', timeout: 5 }],
  });
});
