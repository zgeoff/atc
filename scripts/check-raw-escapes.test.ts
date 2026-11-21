import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';

function setupTest() {
  const temporaryDirectory = createTempDir('check-raw-escapes-');

  return { directory: temporaryDirectory.path };
}

test('it passes a source that writes ESC as an escape', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'packages/tui/src/a.ts'),
    "export const CLEAR = '\\u001B[2J';\n",
  );

  const checked = await run([
    process.execPath,
    join(import.meta.dir, 'check-raw-escapes.ts'),
    ctx.directory,
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
    join(ctx.directory, 'packages/tui/src/a.ts'),
    "// clears the screen\nexport const CLEAR = '\u001B[2J';\n",
  );

  await Bun.write(join(ctx.directory, 'mods/bridge/b.mjs'), 'export const RESET = `\u001B[0m`;\n');
  await Bun.write(join(ctx.directory, 'packages/tui/fixture.txt'), '\u001B[0m\n');

  const checked = await run([
    process.execPath,
    join(import.meta.dir, 'check-raw-escapes.ts'),
    ctx.directory,
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
