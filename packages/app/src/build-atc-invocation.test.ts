import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildATCInvocation } from './build-atc-invocation';
import { getATCBuild } from './shared/get-atc-build';

test('it starts the CLI entrypoint under bun from a source tree', () => {
  expect(buildATCInvocation().argv).toStrictEqual([
    process.execPath,
    join(import.meta.dir, 'cli.ts'),
  ]);
});

test('it reads the build stamp of the source tree', () => {
  expect(buildATCInvocation().readBuild()).toBe(getATCBuild());
});
