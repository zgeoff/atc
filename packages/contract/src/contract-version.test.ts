import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { CONTRACT_VERSION } from './contract-version';

test('it carries the version of the atc release that publishes it', async () => {
  const atc: unknown = await Bun.file(join(import.meta.dir, '../../../package.json')).json();

  expect(atc).toMatchObject({ name: '@zgeoff/atc', version: CONTRACT_VERSION });
});

test('it carries the version its manifest publishes', async () => {
  const manifest: unknown = await Bun.file(join(import.meta.dir, '../package.json')).json();

  expect(manifest).toMatchObject({ name: '@atcx/contract', version: CONTRACT_VERSION });
});
