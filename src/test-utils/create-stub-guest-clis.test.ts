import { expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createStubGuestCLIs } from './create-stub-guest-clis';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-stub-guest-clis-');
}

test('it creates both tools under the directory', () => {
  using ctx = setupTest();

  expect(createStubGuestCLIs(ctx.dir)).toStrictEqual({
    atc: join(ctx.dir, 'atc'),
    claude: join(ctx.dir, 'claude'),
  });
});

test('it creates an atc that runs the CLI of this source tree', () => {
  using ctx = setupTest();

  const clis = createStubGuestCLIs(ctx.dir);
  const result = Bun.spawnSync([clis.atc, 'help']);

  expect(result.stdout.toString()).toInclude('Terminal control tower for coding-agent sessions');
});

test('it creates a claude that prints its pid, then echoes each line it reads', () => {
  using ctx = setupTest();

  const clis = createStubGuestCLIs(ctx.dir);
  const result = Bun.spawnSync([clis.claude], { stdin: Buffer.from('hello\n') });

  expect(result.stdout.toString()).toMatch(/^UP:\d+\nGOT:hello\n$/);
});

test('it makes both tools executable', () => {
  using ctx = setupTest();

  const clis = createStubGuestCLIs(ctx.dir);

  expect([statSync(clis.atc).mode & 0o111, statSync(clis.claude).mode & 0o111]).toStrictEqual([
    0o111, 0o111,
  ]);
});
