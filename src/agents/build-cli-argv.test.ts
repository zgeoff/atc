import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildCLIArgv } from './build-cli-argv';

test('it runs the source entry under bun outside a compiled binary', () => {
  expect(buildCLIArgv()).toStrictEqual([process.execPath, join(import.meta.dir, '..', 'cli.ts')]);
});
