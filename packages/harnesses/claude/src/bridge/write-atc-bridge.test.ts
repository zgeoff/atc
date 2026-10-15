import { expect, test } from 'bun:test';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
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
  const written = writeATCBridge(['/opt/atc/bin/atc'], ctx.folder);

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

test('it leaves a file whose content already matches untouched', () => {
  const ctx = setupTest();
  const register = join(ctx.folder, 'hooks', 'register.ts');

  writeATCBridge(['/opt/atc/bin/atc'], ctx.folder);
  utimesSync(register, new Date(1_000_000_000_000), new Date(1_000_000_000_000));

  const before = statSync(register).mtimeMs;

  writeATCBridge(['/opt/atc/bin/atc'], ctx.folder);

  expect(statSync(register).mtimeMs).toBe(before);
});

test('it rewrites a file whose content changed', () => {
  const ctx = setupTest();
  const register = join(ctx.folder, 'hooks', 'register.ts');

  writeATCBridge(['/opt/atc/bin/atc'], ctx.folder);
  writeFileSync(register, 'stale');
  writeATCBridge(['/opt/atc/bin/atc'], ctx.folder);

  expect(readFileSync(register, 'utf8')).toBe(ATC_BRIDGE_FILES['hooks/register.ts']);
});
