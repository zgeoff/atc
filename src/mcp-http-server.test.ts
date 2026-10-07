import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { setupTempDir } from './test-utils/setup-temp-dir';
import { waitFor } from './test-utils/wait-for';

/**
 * A fresh home whose computed daemon socket sits in it, and a way to run
 * the CLI there. Disposal stops every process it started and removes the
 * home.
 */
function setupTest() {
  const tmp = setupTempDir('atc-mcp-http-wait-');
  const procs: Subprocess<'ignore', 'pipe', 'pipe'>[] = [];

  return {
    dir: tmp.dir,
    runCLI(args: readonly string[]) {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), ...args], {
        env: { ...process.env, HOME: tmp.dir, XDG_RUNTIME_DIR: tmp.dir },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      procs.push(proc);

      return proc;
    },
    async [Symbol.asyncDispose]() {
      for (const proc of procs) {
        proc.kill('SIGTERM');
      }

      await Promise.all(procs.map((proc) => proc.exited));
      await tmp[Symbol.asyncDispose]();
    },
  };
}

test('it waits for a daemon started after it, starting none itself, and serves through that daemon', async () => {
  await using home = setupTest();

  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  const port = probe.port;

  probe.stop(true);

  const mcp = home.runCLI(['mcp', '--http', '--wait-for-daemon', '--port', String(port)]);

  // No signal marks a wait that has started no daemon, so this gives an
  // auto-spawn far longer than it needs to write its record.
  await Bun.sleep(1500);

  expect(existsSync(join(home.dir, '.local', 'state', 'atc', 'daemon.json'))).toBeFalse();
  expect(existsSync(join(home.dir, 'atc-daemon.sock'))).toBeFalse();
  expect(mcp.exitCode).toBeNull();

  const daemon = home.runCLI(['daemon']);

  const record = await waitFor((): unknown =>
    JSON.parse(readFileSync(join(home.dir, '.local', 'state', 'atc', 'daemon.json'), 'utf8')),
  );

  const served = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });

      return response.status;
    },
    { timeoutMs: 10_000 },
  );

  expect(served).toBe(401);
  expect(record).toMatchObject({ pid: daemon.pid });
  expect(daemon.exitCode).toBeNull();
});
