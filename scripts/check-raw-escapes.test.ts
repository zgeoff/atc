import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';

// A temp directory standing in for a repo root.
function setupTest() {
  const tmp = setupTempDir('check-raw-escapes-');

  return { dir: tmp.dir };
}

test('it passes a source that writes ESC as an escape', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/tui/src/a.ts'), "export const CLEAR = '\\u001B[2J';\n");

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-raw-escapes.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-raw-escapes: 0 raw ESC bytes\n',
    stderr: '',
  });
});

test('it fails on a raw ESC byte in a source module and names the escape to write', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/tui/src/a.ts'),
    "// clears the screen\nexport const CLEAR = '\u001B[2J';\n",
  );

  await Bun.write(join(ctx.dir, 'mods/bridge/b.mjs'), 'export const RESET = `\u001B[0m`;\n');

  // a file outside the source extensions is not a source module
  await Bun.write(join(ctx.dir, 'packages/tui/fixture.txt'), '\u001B[0m\n');

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-raw-escapes.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-raw-escapes: 2 raw ESC bytes\n',
    stderr: [
      String.raw`raw ESC byte: packages/tui/src/a.ts:2:23; write it as \u001B`,
      String.raw`raw ESC byte: mods/bridge/b.mjs:1:23; write it as \u001B`,
      '',
    ].join('\n'),
  });
});
