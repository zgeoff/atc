import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { spawn } from 'bun-pty';
import { tryKill } from './try-kill';

function setupTest() {
  const pty = spawn('sleep', ['30'], { name: 'xterm-256color', cols: 80, rows: 24 });

  const exited = Promise.withResolvers<{
    readonly exitCode: number;
    readonly signal?: number | string;
  }>();

  pty.onExit((exit) => {
    exited.resolve(exit);
  });

  registerTestCleanup(async () => {
    try {
      process.kill(pty.pid, 'SIGKILL');
    } catch {}

    await exited.promise;
  });

  return { pty, exited: exited.promise };
}

test('it signals the process of the pty', async () => {
  const ctx = setupTest();

  tryKill(ctx.pty, 'SIGKILL');

  const exit = await ctx.exited;

  expect(exit.exitCode).not.toBe(0);
});

test('it ignores a process that has already exited', async () => {
  const ctx = setupTest();

  tryKill(ctx.pty, 'SIGKILL');

  await ctx.exited;

  expect(() => {
    tryKill(ctx.pty, 'SIGKILL');
  }).not.toThrow();
});
