import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';

// A temp directory standing in for a repo root, with a local and a remote
// execution provider package linked where the bundler resolves them.
async function setupTest() {
  const tmp = setupTempDir('check-bundle-');

  // the local provider, which the local-only build keeps
  await Bun.write(
    join(tmp.path, 'packages/execution/local/package.json'),
    JSON.stringify({ name: '@atc/execution-local', exports: { './*': './src/*.ts' } }),
  );

  await Bun.write(
    join(tmp.path, 'packages/execution/local/src/local-plugin.ts'),
    "export const LOCAL_PLUGIN = { id: 'local-pty' };\n",
  );

  // the remote provider, with an external package that only it depends on
  await Bun.write(
    join(tmp.path, 'packages/execution/remote/package.json'),
    JSON.stringify({
      name: '@atc/execution-remote',
      exports: { './*': './src/*.ts' },
      dependencies: { 'remote-sdk': '1.0.0' },
    }),
  );

  await Bun.write(
    join(tmp.path, 'packages/execution/remote/src/remote-plugin.ts'),
    "import { connect } from 'remote-sdk';\n\nexport const REMOTE_PLUGIN = { id: 'remote', connect };\n",
  );

  await Bun.write(
    join(tmp.path, 'node_modules/remote-sdk/package.json'),
    JSON.stringify({ name: 'remote-sdk', main: 'index.js' }),
  );

  await Bun.write(
    join(tmp.path, 'node_modules/remote-sdk/index.js'),
    'export function connect() {}\n',
  );

  // the app's manifest, which the provider scan reads beside the providers'
  await Bun.write(
    join(tmp.path, 'packages/app/package.json'),
    JSON.stringify({ name: '@atc/app' }),
  );

  mkdirSync(join(tmp.path, 'node_modules/@atc'), { recursive: true });

  symlinkSync(
    join(tmp.path, 'packages/execution/local'),
    join(tmp.path, 'node_modules/@atc/execution-local'),
  );

  symlinkSync(
    join(tmp.path, 'packages/execution/remote'),
    join(tmp.path, 'node_modules/@atc/execution-remote'),
  );

  return { dir: tmp.path };
}

test('it passes a bundle that reaches each provider only through the shipped list', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/plugins/shipped-execution-plugins.ts'),
    "import { LOCAL_PLUGIN } from '@atc/execution-local/local-plugin';\nimport { REMOTE_PLUGIN } from '@atc/execution-remote/remote-plugin';\n\nexport const SHIPPED_EXECUTION_PLUGINS = [LOCAL_PLUGIN, REMOTE_PLUGIN];\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/cli.ts'),
    "import { SHIPPED_EXECUTION_PLUGINS } from './plugins/shipped-execution-plugins';\n\nconsole.log(SHIPPED_EXECUTION_PLUGINS);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-bundle.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout:
      'check-bundle: atc keeps @atc/execution-local, @atc/execution-remote and bundles 5 inputs\ncheck-bundle: local-only atc keeps @atc/execution-local and bundles 3 inputs\ncheck-bundle: 0 findings\n',
    stderr: '',
  });
});

test('it passes a bundle that reaches each provider only through the shipped list when the root is a link', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/plugins/shipped-execution-plugins.ts'),
    "import { LOCAL_PLUGIN } from '@atc/execution-local/local-plugin';\nimport { REMOTE_PLUGIN } from '@atc/execution-remote/remote-plugin';\n\nexport const SHIPPED_EXECUTION_PLUGINS = [LOCAL_PLUGIN, REMOTE_PLUGIN];\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/cli.ts'),
    "import { SHIPPED_EXECUTION_PLUGINS } from './plugins/shipped-execution-plugins';\n\nconsole.log(SHIPPED_EXECUTION_PLUGINS);\n",
  );

  const links = setupTempDir('check-bundle-link-');

  symlinkSync(ctx.dir, join(links.path, 'root'));

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-bundle.ts'),
    join(links.path, 'root'),
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout:
      'check-bundle: atc keeps @atc/execution-local, @atc/execution-remote and bundles 5 inputs\ncheck-bundle: local-only atc keeps @atc/execution-local and bundles 3 inputs\ncheck-bundle: 0 findings\n',
    stderr: '',
  });
});

test('it fails a bundle that carries a provider the shipped list leaves out when the root is a link', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/plugins/shipped-execution-plugins.ts'),
    "import { LOCAL_PLUGIN } from '@atc/execution-local/local-plugin';\n\nexport const SHIPPED_EXECUTION_PLUGINS = [LOCAL_PLUGIN];\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/cli.ts'),
    "import { REMOTE_PLUGIN } from '@atc/execution-remote/remote-plugin';\nimport { SHIPPED_EXECUTION_PLUGINS } from './plugins/shipped-execution-plugins';\n\nconsole.log(SHIPPED_EXECUTION_PLUGINS, REMOTE_PLUGIN);\n",
  );

  const links = setupTempDir('check-bundle-link-');

  symlinkSync(ctx.dir, join(links.path, 'root'));

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-bundle.ts'),
    join(links.path, 'root'),
  ]);

  expect({ exitCode: checked.exitCode, stderr: checked.stderr }).toStrictEqual({
    exitCode: 1,
    stderr:
      'unshipped provider: atc bundles packages/execution/remote/src/remote-plugin.ts (@atc/execution-remote)\nunshipped provider: atc bundles remote-sdk, which only @atc/execution-remote depends on\nunshipped provider: local-only atc bundles packages/execution/remote/src/remote-plugin.ts (@atc/execution-remote)\nunshipped provider: local-only atc bundles remote-sdk, which only @atc/execution-remote depends on\n',
  });
});

test('it drops a provider that the shipped list imports through its root entry point', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/execution/remote/package.json'),
    JSON.stringify({
      name: '@atc/execution-remote',
      exports: { '.': './src/index.ts' },
      dependencies: { 'remote-sdk': '1.0.0' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/execution/remote/src/index.ts'),
    "export * from './remote-plugin';\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/plugins/shipped-execution-plugins.ts'),
    "import { LOCAL_PLUGIN } from '@atc/execution-local/local-plugin';\nimport { REMOTE_PLUGIN } from '@atc/execution-remote';\n\nexport const SHIPPED_EXECUTION_PLUGINS = [LOCAL_PLUGIN, REMOTE_PLUGIN];\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/cli.ts'),
    "import { SHIPPED_EXECUTION_PLUGINS } from './plugins/shipped-execution-plugins';\n\nconsole.log(SHIPPED_EXECUTION_PLUGINS);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-bundle.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout:
      'check-bundle: atc keeps @atc/execution-local, @atc/execution-remote and bundles 6 inputs\ncheck-bundle: local-only atc keeps @atc/execution-local and bundles 3 inputs\ncheck-bundle: 0 findings\n',
    stderr: '',
  });
});

test('it finds a provider outside the shipped list when it runs from a directory that holds the root', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/plugins/shipped-execution-plugins.ts'),
    "import { LOCAL_PLUGIN } from '@atc/execution-local/local-plugin';\nimport { REMOTE_PLUGIN } from '@atc/execution-remote/remote-plugin';\n\nexport const SHIPPED_EXECUTION_PLUGINS = [LOCAL_PLUGIN, REMOTE_PLUGIN];\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/cli.ts'),
    "import { REMOTE_PLUGIN } from '@atc/execution-remote/remote-plugin';\nimport { SHIPPED_EXECUTION_PLUGINS } from './plugins/shipped-execution-plugins';\n\nconsole.log(SHIPPED_EXECUTION_PLUGINS, REMOTE_PLUGIN);\n",
  );

  const checked = await runCommand(
    [process.execPath, join(import.meta.dir, 'check-bundle.ts'), ctx.dir],
    { cwd: dirname(ctx.dir) },
  );

  expect({ exitCode: checked.exitCode, stderr: checked.stderr }).toStrictEqual({
    exitCode: 1,
    stderr:
      'unshipped provider: local-only atc bundles packages/execution/remote/src/remote-plugin.ts (@atc/execution-remote)\nunshipped provider: local-only atc bundles remote-sdk, which only @atc/execution-remote depends on\n',
  });
});

test('it fails a local-only bundle that reaches a provider outside the shipped list', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/plugins/shipped-execution-plugins.ts'),
    "import { LOCAL_PLUGIN } from '@atc/execution-local/local-plugin';\nimport { REMOTE_PLUGIN } from '@atc/execution-remote/remote-plugin';\n\nexport const SHIPPED_EXECUTION_PLUGINS = [LOCAL_PLUGIN, REMOTE_PLUGIN];\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/cli.ts'),
    "import { REMOTE_PLUGIN } from '@atc/execution-remote/remote-plugin';\nimport { SHIPPED_EXECUTION_PLUGINS } from './plugins/shipped-execution-plugins';\n\nconsole.log(SHIPPED_EXECUTION_PLUGINS, REMOTE_PLUGIN);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-bundle.ts'),
    ctx.dir,
  ]);

  expect({ exitCode: checked.exitCode, stderr: checked.stderr }).toStrictEqual({
    exitCode: 1,
    stderr:
      'unshipped provider: local-only atc bundles packages/execution/remote/src/remote-plugin.ts (@atc/execution-remote)\nunshipped provider: local-only atc bundles remote-sdk, which only @atc/execution-remote depends on\n',
  });
});

test('it fails a bundle that carries a provider the shipped list leaves out', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/plugins/shipped-execution-plugins.ts'),
    "import { LOCAL_PLUGIN } from '@atc/execution-local/local-plugin';\n\nexport const SHIPPED_EXECUTION_PLUGINS = [LOCAL_PLUGIN];\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/cli.ts'),
    "import { REMOTE_PLUGIN } from '@atc/execution-remote/remote-plugin';\nimport { SHIPPED_EXECUTION_PLUGINS } from './plugins/shipped-execution-plugins';\n\nconsole.log(SHIPPED_EXECUTION_PLUGINS, REMOTE_PLUGIN);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-bundle.ts'),
    ctx.dir,
  ]);

  expect({ exitCode: checked.exitCode, stderr: checked.stderr }).toStrictEqual({
    exitCode: 1,
    stderr:
      'unshipped provider: atc bundles packages/execution/remote/src/remote-plugin.ts (@atc/execution-remote)\nunshipped provider: atc bundles remote-sdk, which only @atc/execution-remote depends on\nunshipped provider: local-only atc bundles packages/execution/remote/src/remote-plugin.ts (@atc/execution-remote)\nunshipped provider: local-only atc bundles remote-sdk, which only @atc/execution-remote depends on\n',
  });
});

test('it fails a bundle that keeps a provider but carries none of its files', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/plugins/shipped-execution-plugins.ts'),
    "import type { LOCAL_PLUGIN } from '@atc/execution-local/local-plugin';\n\nexport const SHIPPED_EXECUTION_PLUGINS: (typeof LOCAL_PLUGIN)[] = [];\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/cli.ts'),
    "import { SHIPPED_EXECUTION_PLUGINS } from './plugins/shipped-execution-plugins';\n\nconsole.log(SHIPPED_EXECUTION_PLUGINS);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-bundle.ts'),
    ctx.dir,
  ]);

  expect({ exitCode: checked.exitCode, stderr: checked.stderr }).toStrictEqual({
    exitCode: 1,
    stderr:
      'missing provider: atc keeps @atc/execution-local but bundles none of it\nmissing provider: local-only atc keeps @atc/execution-local but bundles none of it\n',
  });
});
