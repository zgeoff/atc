import { expect, test } from 'bun:test';
import { collectAgents } from '@atc/config';
import { buildHarnessPlugins } from './build-harness-plugins';
import { SHIPPED_HARNESS_PLUGINS } from './shipped-harness-plugins';

test('it ships the config of each harness plugin, in their order and with their fields', () => {
  expect(SHIPPED_HARNESS_PLUGINS.map((plugin) => [plugin.id, plugin.configFields])).toStrictEqual(
    buildHarnessPlugins().map((plugin) => [plugin.id, plugin.configFields]),
  );
});

test('it reads an entry of each kind as the harness plugins read it', () => {
  const raw = {
    claude: { args: ['--a'], baseURL: 'https://gateway.example.test' },
    grok: { mark: 'x' },
    'codex-b': { kind: 'codex', auth: { mode: 'none' } },
    'mystery-c': { kind: 'mystery' },
  };

  expect(collectAgents(raw, new Map(), SHIPPED_HARNESS_PLUGINS)).toStrictEqual(
    collectAgents(raw, new Map(), buildHarnessPlugins()),
  );
});
