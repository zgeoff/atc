import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json';
import { runCommand } from '../test-utils/run-command';
import { buildCLIArgv } from './build-cli-argv';

test('it runs the source entry under bun outside a compiled binary', async () => {
  const repoRoot = dirname(fileURLToPath(import.meta.resolve('../../package.json')));
  const argv = buildCLIArgv(false);

  const run = await runCommand([...argv, '--version']);

  expect(argv).toStrictEqual([process.execPath, join(repoRoot, 'src/cli.ts')]);
  expect(run.stdout).toBe(`${pkg.version}\n`);
});

test('it runs the binary itself as the entry inside a compiled binary', () => {
  expect(buildCLIArgv(true)).toStrictEqual([process.execPath]);
});
