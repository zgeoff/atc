import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import invariant from 'tiny-invariant';
import { resolveATCCommand } from './resolve-atc-command';
import { runCommand } from './run-command';
import { updateEnv } from './update-env';

test('it runs the source entry under the test bun when no binary is set', () => {
  const appRoot = dirname(fileURLToPath(import.meta.resolve('../../app/package.json')));

  updateEnv('ATC_BIN', undefined);

  expect(resolveATCCommand()).toStrictEqual([process.execPath, join(appRoot, 'src/cli.ts')]);
});

test('it runs the compiled binary the environment points at', () => {
  updateEnv('ATC_BIN', '/opt/atc/bin/atc');

  expect(resolveATCCommand()).toStrictEqual(['/opt/atc/bin/atc']);
});

test('it runs a source entry that prints the package version', async () => {
  updateEnv('ATC_BIN', undefined);

  const pkg: unknown = await Bun.file(
    join(import.meta.dir, '..', '..', 'app', 'package.json'),
  ).json();

  const printed = await runCommand([...resolveATCCommand(), '--version']);

  invariant(
    typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string',
    'package.json holds no version',
  );

  expect(printed.stdout.trim()).toBe(pkg.version);
});
