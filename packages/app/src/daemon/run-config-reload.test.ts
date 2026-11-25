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

          return ['a problem the daemon found'];
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
    { adapters: [], defaultAgent: 'claude', defaultTarget: 'local', hooks: {} },
  ]);

  expect(ctx.lines).toStrictEqual(['atc daemon: config: a problem the daemon found']);
});

test('it keeps the old config and names the cause when the file is unusable', () => {
  const ctx = setupTest();
  const config = parseConfig(buildStubHarnessPlugins(), 'text', '/c.json');

  runConfigReload({ ...ctx.deps, loadConfig: () => config });

  expect(ctx.reloads).toStrictEqual([]);

  expect(ctx.lines).toStrictEqual([
    'atc daemon: config reload failed (/c.json cannot be used: config_malformed, the root is a string, not an object); the daemon keeps its old config',
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

test('it keeps the old config when loading the file throws', () => {
  const ctx = setupTest();

  runConfigReload({
    ...ctx.deps,
    loadConfig: () => {
      throw new Error('the file vanished');
    },
  });

  expect(ctx.reloads).toStrictEqual([]);

  expect(ctx.lines).toStrictEqual([
    'atc daemon: config reload failed (the file vanished); the daemon keeps its old config',
  ]);
});

test('it leaves the default target out of the reload and prints the problem when the file names a bad one', () => {
  const ctx = setupTest();

  const config = parseConfig(
    buildStubHarnessPlugins(),
    { targets: { box: { provider: 'local-pty' } }, defaultTarget: 'ghost' },
    '/c.json',
  );

  runConfigReload({ ...ctx.deps, loadConfig: () => config });

  expect(ctx.reloads).toStrictEqual([{ adapters: [], defaultAgent: 'claude', hooks: {} }]);

  expect(ctx.lines).toStrictEqual([
    'atc daemon: config: defaultTarget: matches no well-formed target in targets',
    'atc daemon: config: a problem the daemon found',
  ]);
});
