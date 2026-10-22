import { expect, test } from 'bun:test';
import { loadExecutionPlugins } from './load-execution-plugins';

test('it loads only the plugins the targets name, each once', async () => {
  const plugins = await loadExecutionPlugins([
    { id: 'local', provider: 'local-pty', options: {} },
    { id: 'spare', provider: 'local-pty', options: {} },
  ]);

  expect(plugins.map((plugin) => plugin.id)).toStrictEqual(['local-pty']);
});

test('it loads no plugin for a provider this build does not ship', async () => {
  const plugins = await loadExecutionPlugins([{ id: 'far', provider: 'teleport', options: {} }]);

  expect(plugins).toStrictEqual([]);
});
