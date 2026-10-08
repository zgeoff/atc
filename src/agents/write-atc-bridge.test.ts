import { expect, test } from 'bun:test';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { ATC_BRIDGE_FILES } from './atc-bridge-files';
import { writeATCBridge } from './write-atc-bridge';

// A temp root with an empty folder for a first write, and a folder the mod
// was already written into once.
function setupTest() {
  const temp = setupTempDir('atc-bridge-');
  const written = join(temp.dir, 'written');

  writeATCBridge(written);

  return { empty: join(temp.dir, 'empty'), written, [Symbol.dispose]: temp[Symbol.dispose] };
}

test('it writes the mod files and the atc command into the folder', () => {
  using ctx = setupTest();

  const written = writeATCBridge(ctx.empty, ['/opt/atc/bin/atc']);

  expect({
    written,
    plugin: readFileSync(join(ctx.empty, '.claude-plugin', 'plugin.json'), 'utf8'),
    hooks: readFileSync(join(ctx.empty, 'hooks', 'hooks.json'), 'utf8'),
    register: readFileSync(join(ctx.empty, 'hooks', 'register.ts'), 'utf8'),
    cli: readFileSync(join(ctx.empty, 'hooks', 'atc-cli.ts'), 'utf8'),
  }).toStrictEqual({
    written: ctx.empty,
    plugin: ATC_BRIDGE_FILES['.claude-plugin/plugin.json'],
    hooks: ATC_BRIDGE_FILES['hooks/hooks.json'],
    register: ATC_BRIDGE_FILES['hooks/register.ts'],
    cli: 'export const ATC_CLI: readonly string[] = ["/opt/atc/bin/atc"];\n',
  });
});

test("it renders this install's own atc command by default", () => {
  using ctx = setupTest();

  const repoRoot = dirname(fileURLToPath(import.meta.resolve('../../package.json')));

  writeATCBridge(ctx.empty);

  // Under bun, this install's command runs the source entry with the running
  // bun.
  const argv = [process.execPath, join(repoRoot, 'src/cli.ts')];

  expect(readFileSync(join(ctx.empty, 'hooks', 'atc-cli.ts'), 'utf8')).toBe(
    `export const ATC_CLI: readonly string[] = ${JSON.stringify(argv)};\n`,
  );
});

test('it leaves a file whose content already matches untouched', () => {
  using ctx = setupTest();

  const register = join(ctx.written, 'hooks', 'register.ts');

  utimesSync(register, new Date(1_000_000_000_000), new Date(1_000_000_000_000));

  const before = statSync(register).mtimeMs;

  writeATCBridge(ctx.written);

  expect(statSync(register).mtimeMs).toBe(before);
});

test('it rewrites a file whose content changed', () => {
  using ctx = setupTest();

  const register = join(ctx.written, 'hooks', 'register.ts');

  writeFileSync(register, 'stale');
  writeATCBridge(ctx.written);

  expect(readFileSync(register, 'utf8')).toBe(ATC_BRIDGE_FILES['hooks/register.ts']);
});
