import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { z } from 'zod';
import { loadExecutionPlugins } from './load-execution-plugins';

test('it loads only the plugins the targets name, each once', async () => {
  const plugins = await loadExecutionPlugins([
    { id: 'local', provider: 'local-pty', options: {} },
    { id: 'spare', provider: 'local-pty', options: {} },
  ]);

  expect(plugins.map((plugin) => plugin.id)).toStrictEqual(['local-pty']);
});

test('it loads the modules of no provider but the one the targets name', async () => {
  const loader = join(import.meta.dir, 'load-execution-plugins.ts');
  const script = `const { loadExecutionPlugins } = await import(${JSON.stringify(loader)}); await loadExecutionPlugins([{ id: 'local', provider: 'local-pty', options: {} }]); console.log(JSON.stringify(Object.keys(require.cache)));`;
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe' });

  const output = await new Response(child.stdout).text();

  const loaded = z.array(z.string()).parse(JSON.parse(output));
  const providerModules = loaded.filter((path) => path.includes('/packages/execution/'));

  expect(providerModules).toContainEqual(
    expect.stringContaining('/packages/execution/local/src/index.ts'),
  );

  expect(providerModules).toSatisfyAll((path: string) =>
    path.includes('/packages/execution/local/'),
  );
});

test('it loads no plugin for a provider this build does not ship', async () => {
  const plugins = await loadExecutionPlugins([{ id: 'far', provider: 'teleport', options: {} }]);

  expect(plugins).toStrictEqual([]);
});
