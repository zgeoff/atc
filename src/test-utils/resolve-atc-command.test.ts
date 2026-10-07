import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveATCCommand } from './resolve-atc-command';
import { updateEnv } from './update-env';

test('it runs the source entry under the test bun when no binary is set', () => {
  updateEnv('ATC_BIN', undefined);

  expect(resolveATCCommand()).toStrictEqual([
    process.execPath,
    join(import.meta.dir, '..', 'cli.ts'),
  ]);
});

test('it runs the compiled binary the environment points at', () => {
  updateEnv('ATC_BIN', '/opt/atc/bin/atc');

  expect(resolveATCCommand()).toStrictEqual(['/opt/atc/bin/atc']);
});

test('it runs a source entry that prints the package version', async () => {
  updateEnv('ATC_BIN', undefined);

  const pkg: unknown = await Bun.file(join(import.meta.dir, '..', '..', 'package.json')).json();

  const printed = Bun.spawnSync([...resolveATCCommand(), '--version']);

  expect(pkg).toMatchObject({ version: printed.stdout.toString().trim() });
});
