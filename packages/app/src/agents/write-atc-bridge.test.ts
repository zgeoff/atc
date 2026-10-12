import { expect, test } from 'bun:test';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { ATC_BRIDGE_FILES } from './atc-bridge-files';
import { writeATCBridge } from './write-atc-bridge';

// The folder a test writes the mod into, inside a fresh temp root; nothing
// exists there until the test writes it.
function setupTest() {
  const temp = setupTempDir('atc-bridge-');

  return { folder: join(temp.dir, 'atc-bridge') };
}

test('it writes the mod files and the atc command into the folder', () => {
  const ctx = setupTest();
  const written = writeATCBridge(ctx.folder, ['/opt/atc/bin/atc']);

  expect(written).toBe(ctx.folder);

  expect(readFileSync(join(ctx.folder, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(
    ATC_BRIDGE_FILES['.claude-plugin/plugin.json'],
  );

  expect(readFileSync(join(ctx.folder, 'hooks', 'hooks.json'), 'utf8')).toBe(
    ATC_BRIDGE_FILES['hooks/hooks.json'],
  );

  expect(readFileSync(join(ctx.folder, 'hooks', 'register.ts'), 'utf8')).toBe(
    ATC_BRIDGE_FILES['hooks/register.ts'],
  );

  expect(readFileSync(join(ctx.folder, 'hooks', 'atc-cli.ts'), 'utf8')).toBe(
    'export const ATC_CLI: readonly string[] = ["/opt/atc/bin/atc"];\n',
  );
});

test("it renders this install's own atc command by default", () => {
  const ctx = setupTest();
  const repoRoot = dirname(fileURLToPath(import.meta.resolve('../../package.json')));

  writeATCBridge(ctx.folder);

  // Under bun, this install's command runs the source entry with the running
  // bun.
  const argv = [process.execPath, join(repoRoot, 'src/cli.ts')];

  expect(readFileSync(join(ctx.folder, 'hooks', 'atc-cli.ts'), 'utf8')).toBe(
    `export const ATC_CLI: readonly string[] = ${JSON.stringify(argv)};\n`,
  );
});

test('it leaves a file whose content already matches untouched', () => {
  const ctx = setupTest();
  const register = join(ctx.folder, 'hooks', 'register.ts');

  writeATCBridge(ctx.folder);
  utimesSync(register, new Date(1_000_000_000_000), new Date(1_000_000_000_000));

  const before = statSync(register).mtimeMs;

  writeATCBridge(ctx.folder);

  expect(statSync(register).mtimeMs).toBe(before);
});

test('it rewrites a file whose content changed', () => {
  const ctx = setupTest();
  const register = join(ctx.folder, 'hooks', 'register.ts');

  writeATCBridge(ctx.folder);
  writeFileSync(register, 'stale');
  writeATCBridge(ctx.folder);

  expect(readFileSync(register, 'utf8')).toBe(ATC_BRIDGE_FILES['hooks/register.ts']);
});
