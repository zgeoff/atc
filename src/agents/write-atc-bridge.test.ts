import { expect, test } from 'bun:test';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { ATC_BRIDGE_FILES } from './atc-bridge-files';
import { buildCLIArgv } from './build-cli-argv';
import { writeATCBridge } from './write-atc-bridge';

// The folder the mod is written into.
function setupTest() {
  return setupTempDir('atc-bridge-');
}

test('it writes the mod files and the atc command into the folder', () => {
  using ctx = setupTest();

  const dir = join(ctx.dir, 'atc-bridge');
  const written = writeATCBridge(dir);

  expect({
    written,
    plugin: readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'),
    hooks: readFileSync(join(dir, 'hooks', 'hooks.json'), 'utf8'),
    register: readFileSync(join(dir, 'hooks', 'register.ts'), 'utf8'),
    cli: readFileSync(join(dir, 'hooks', 'atc-cli.ts'), 'utf8'),
  }).toStrictEqual({
    written: dir,
    plugin: ATC_BRIDGE_FILES['.claude-plugin/plugin.json'],
    hooks: ATC_BRIDGE_FILES['hooks/hooks.json'],
    register: ATC_BRIDGE_FILES['hooks/register.ts'],
    cli: `export const ATC_CLI: readonly string[] = ${JSON.stringify(buildCLIArgv())};\n`,
  });
});

test('it leaves a file whose content already matches untouched', () => {
  using ctx = setupTest();

  const register = join(ctx.dir, 'hooks', 'register.ts');

  writeATCBridge(ctx.dir);
  utimesSync(register, new Date(1_000_000_000_000), new Date(1_000_000_000_000));

  const before = statSync(register).mtimeMs;

  writeATCBridge(ctx.dir);

  expect(statSync(register).mtimeMs).toBe(before);
});

test('it rewrites a file whose content changed', () => {
  using ctx = setupTest();

  const register = join(ctx.dir, 'hooks', 'register.ts');

  writeATCBridge(ctx.dir);
  writeFileSync(register, 'stale');
  writeATCBridge(ctx.dir);

  expect(readFileSync(register, 'utf8')).toBe(ATC_BRIDGE_FILES['hooks/register.ts']);
});
