import { expect, test } from 'bun:test';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { ATC_BRIDGE_FILES } from './atc-bridge-files';
import { buildCLIArgv } from './build-cli-argv';
import { writeATCBridge } from './write-atc-bridge';

test('it writes the mod files and the atc command into the folder', () => {
  using tmp = setupTempDir('atc-bridge-');

  const dir = join(tmp.dir, 'atc-bridge');
  const written = writeATCBridge(dir);

  expect(written).toBe(dir);

  expect(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(
    ATC_BRIDGE_FILES['.claude-plugin/plugin.json'],
  );

  expect(readFileSync(join(dir, 'hooks', 'hooks.json'), 'utf8')).toBe(
    ATC_BRIDGE_FILES['hooks/hooks.json'],
  );

  expect(readFileSync(join(dir, 'hooks', 'register.ts'), 'utf8')).toBe(
    ATC_BRIDGE_FILES['hooks/register.ts'],
  );

  expect(readFileSync(join(dir, 'hooks', 'atc-cli.ts'), 'utf8')).toBe(
    `export const ATC_CLI: readonly string[] = ${JSON.stringify(buildCLIArgv())};\n`,
  );
});

test('it leaves a file whose content already matches untouched', () => {
  using tmp = setupTempDir('atc-bridge-');

  const register = join(tmp.dir, 'hooks', 'register.ts');

  writeATCBridge(tmp.dir);
  utimesSync(register, new Date(1_000_000_000_000), new Date(1_000_000_000_000));

  const before = statSync(register).mtimeMs;

  writeATCBridge(tmp.dir);

  expect(statSync(register).mtimeMs).toBe(before);
});

test('it rewrites a file whose content changed', () => {
  using tmp = setupTempDir('atc-bridge-');

  const register = join(tmp.dir, 'hooks', 'register.ts');

  writeATCBridge(tmp.dir);
  writeFileSync(register, 'stale');
  writeATCBridge(tmp.dir);

  expect(readFileSync(register, 'utf8')).toBe(ATC_BRIDGE_FILES['hooks/register.ts']);
});
