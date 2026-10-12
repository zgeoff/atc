import { expect, test } from 'bun:test';
import { getSourceEntry } from '@atc/test-utils/get-source-entry';
import { buildCLIArgv } from './build-cli-argv';

test('it runs the source entry under bun outside a compiled binary', () => {
  expect(buildCLIArgv(false)).toStrictEqual([process.execPath, getSourceEntry('atc')]);
});

test('it runs the binary itself as the entry inside a compiled binary', () => {
  expect(buildCLIArgv(true)).toStrictEqual([process.execPath]);
});
