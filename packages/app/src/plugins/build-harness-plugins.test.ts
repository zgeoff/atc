import { expect, test } from 'bun:test';
import { collectAgents } from '@atc/config';
import { buildStubHarnessPlugins } from '@atc/test-utils';
import { buildHarnessPlugins } from './build-harness-plugins';

test('it ships the plugins the config stand-ins copy, in their order and with their fields', () => {
  expect(buildHarnessPlugins().map((plugin) => [plugin.id, plugin.configFields])).toStrictEqual(
    buildStubHarnessPlugins().map((plugin) => [plugin.id, plugin.configFields]),
  );
});

test('it reads an entry of each kind as the config stand-ins read it', () => {
  const raw = { claude: { args: ['--a'] }, grok: { mark: 'x' }, 'codex-b': { kind: 'codex' } };

  expect(collectAgents(raw, new Map(), buildHarnessPlugins())).toStrictEqual(
    collectAgents(raw, new Map(), buildStubHarnessPlugins()),
  );
});
