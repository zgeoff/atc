import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStubEchoClaude } from './create-stub-echo-claude';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const tmp = setupTempDir('atc-stub-echo-claude-');

  return { dir: tmp.dir };
}

test('it returns the path of the stub under the directory', () => {
  const ctx = setupTest();

  expect(createStubEchoClaude(ctx.dir)).toBe(join(ctx.dir, 'fake-claude'));
});

test('it prints its pid, then echoes each line with its pid until it reads quit', async () => {
  const ctx = setupTest();
  const bin = createStubEchoClaude(ctx.dir);
  const run = Bun.spawn([bin], { stdin: Buffer.from('one\ntwo\nquit\nafter\n'), stdout: 'pipe' });

  const output = await new Response(run.stdout).text();

  await run.exited;

  expect({ output, exitCode: run.exitCode }).toStrictEqual({
    output: `UP:${String(run.pid)}\nGOT:one:${String(run.pid)}\nGOT:two:${String(run.pid)}\n`,
    exitCode: 3,
  });
});

test('it exits 0 when its input ends without quit', async () => {
  const ctx = setupTest();
  const bin = createStubEchoClaude(ctx.dir);
  const run = Bun.spawn([bin], { stdin: Buffer.from('one\n'), stdout: 'ignore' });

  const exitCode = await run.exited;

  expect(exitCode).toBe(0);
});
