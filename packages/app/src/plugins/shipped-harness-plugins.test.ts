import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { collectAgents } from '@atc/config';
import { z } from 'zod';
import { buildHarnessPlugins } from './build-harness-plugins';
import { SHIPPED_HARNESS_PLUGINS } from './shipped-harness-plugins';

test('it ships the config of each harness plugin, in their order and with their fields', () => {
  expect(SHIPPED_HARNESS_PLUGINS.map((plugin) => [plugin.id, plugin.configFields])).toStrictEqual(
    buildHarnessPlugins().map((plugin) => [plugin.id, plugin.configFields]),
  );
});

test('it loads no harness module outside the config entries', async () => {
  const registry = join(import.meta.dir, 'shipped-harness-plugins.ts');
  const script = `await import(${JSON.stringify(registry)}); console.log(JSON.stringify(Object.keys(require.cache)));`;
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe' });

  const output = await new Response(child.stdout).text();

  const loaded = z.array(z.string()).parse(JSON.parse(output));
  const harnessModules = loaded.filter((path) => path.includes('/packages/harnesses/'));

  expect(harnessModules).toIncludeAllMembers([
    expect.stringContaining('/claude/src/config/claude-config-plugin.ts'),
    expect.stringContaining('/codex/src/config/codex-config-plugin.ts'),
    expect.stringContaining('/grok/src/config/grok-config-plugin.ts'),
  ]);

  expect(harnessModules).toSatisfyAll((path: string) => path.includes('/src/config/'));
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
