import { expect, test } from 'bun:test';
import { parseConfig } from '@atc/config';
import { buildStubHarnessPlugins } from '@atc/config/test-utils/build-stub-harness-plugins';
import type { ReloadedConfig } from '@atc/daemon';
import { runConfigReload } from './run-config-reload';

function setupTest() {
  const reloads: ReloadedConfig[] = [];
  const lines: string[] = [];

  return {
    reloads,
    lines,
    deps: {
      handle: {
        reloadConfig: (config: ReloadedConfig): readonly string[] => {
          reloads.push(config);

          return [];
        },
      },
      buildAdapters: () => [],
      writeLine: (line: string) => {
        lines.push(line);
      },
    },
  };
}

test('it hands the reloaded agents, defaults and hooks to the daemon', () => {
  const ctx = setupTest();
  const config = parseConfig(buildStubHarnessPlugins(), {}, '/c.json');

  runConfigReload({ ...ctx.deps, loadConfig: () => config });

  expect(ctx.reloads).toStrictEqual([
    {
      adapters: [],
      defaultAgent: config.defaultAgent,
      defaultTarget: config.defaultTarget,
      hooks: config.hooks,
    },
  ]);

  expect(ctx.lines).toStrictEqual([]);
});

test('it keeps the old config and names the cause when the file is unusable', () => {
  const ctx = setupTest();
  const config = parseConfig(buildStubHarnessPlugins(), {}, '/c.json');

  runConfigReload({
    ...ctx.deps,
    loadConfig: () => ({
      ...config,
      targetErrors: [
        {
          scope: 'config',
          problem: 'config_malformed',
          path: '/home/river/.config/atc/config.json',
          detail: 'the file is not valid JSON',
        },
      ],
    }),
  });

  expect(ctx.reloads).toStrictEqual([]);

  expect(ctx.lines).toStrictEqual([
    'atc daemon: config reload failed (/home/river/.config/atc/config.json cannot be used: config_malformed, the file is not valid JSON); the daemon keeps its old config',
  ]);
});

test('it keeps the old config when building an adapter throws', () => {
  const ctx = setupTest();
  const config = parseConfig(buildStubHarnessPlugins(), {}, '/c.json');

  runConfigReload({
    ...ctx.deps,
    loadConfig: () => config,
    buildAdapters: () => {
      throw new Error('no harness plugin owns kind other');
    },
  });

  expect(ctx.reloads).toStrictEqual([]);

  expect(ctx.lines).toStrictEqual([
    'atc daemon: config reload failed (no harness plugin owns kind other); the daemon keeps its old config',
  ]);
});

test('it prints each entry problem and each problem the daemon reports', () => {
  const ctx = setupTest();
  const config = parseConfig(buildStubHarnessPlugins(), {}, '/c.json');

  runConfigReload({
    handle: { reloadConfig: () => ["defaultTarget 'ghost' names no target"] },
    buildAdapters: () => [],
    writeLine: ctx.deps.writeLine,
    loadConfig: () => ({ ...config, agentErrors: ['agents.codex: baseURL is not valid'] }),
  });

  expect(ctx.lines).toStrictEqual([
    'atc daemon: config: agents.codex: baseURL is not valid',
    "atc daemon: config: defaultTarget 'ghost' names no target",
  ]);
});
