import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from './test-utils/setup-temp-dir';
import { waitFor } from './test-utils/wait-for';

/**
 * A fresh home whose computed daemon socket sits in it, and a free loopback
 * port for the HTTP server. `runCLI` starts the CLI with that home as its
 * home and runtime directory. Disposal stops every process `runCLI` started,
 * then removes the home.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-mcp-http-wait-'));

  // The CLI refuses port 0, so the server takes a port the kernel handed
  // out and released just before.
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  const port = probe.port;

  probe.stop(true);

  const owned = stack.move();

  const running = new AsyncDisposableStack();

  return {
    dir: tmp.dir,
    port,
    runCLI(args: readonly string[]) {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), ...args], {
        env: { ...process.env, HOME: tmp.dir, XDG_RUNTIME_DIR: tmp.dir },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      running.defer(async () => {
        proc.kill('SIGTERM');

        await proc.exited;
      });

      return proc;
    },
    async [Symbol.asyncDispose]() {
      await running.disposeAsync();

      owned.dispose();
    },
  };
}

test('it starts no daemon while it waits for one', async () => {
  await using ctx = setupTest();

  const mcp = ctx.runCLI(['mcp', '--http', '--wait-for-daemon', '--port', String(ctx.port)]);
  const reader = mcp.stderr.getReader();

  const waiting = await reader.read();

  reader.releaseLock();

  expect({
    stderr: new TextDecoder().decode(waiting.value),
    record: existsSync(join(ctx.dir, '.local', 'state', 'atc', 'daemon.json')),
    socket: existsSync(join(ctx.dir, 'atc-daemon.sock')),
    exitCode: mcp.exitCode,
  }).toStrictEqual({
    stderr:
      'atc mcp --http: no daemon answers yet; waiting up to 30s for one, without starting it\n',
    record: false,
    socket: false,
    exitCode: null,
  });
});

test('it serves through a daemon started after it began to wait', async () => {
  await using ctx = setupTest();

  const mcp = ctx.runCLI(['mcp', '--http', '--wait-for-daemon', '--port', String(ctx.port)]);

  // The server prints this line once it has found no daemon and begun to
  // wait, so the daemon below starts after the wait has begun.
  const reader = mcp.stderr.getReader();

  await reader.read();

  reader.releaseLock();

  const daemon = ctx.runCLI(['daemon']);

  const record = await waitFor((): unknown =>
    JSON.parse(readFileSync(join(ctx.dir, '.local', 'state', 'atc', 'daemon.json'), 'utf8')),
  );

  const served = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, { method: 'POST' });

      return response.status;
    },
    { timeoutMs: 10_000 },
  );

  expect({ served, record, daemonExitCode: daemon.exitCode }).toStrictEqual({
    served: 401,
    record: {
      pid: daemon.pid,
      socketPath: join(ctx.dir, 'atc-daemon.sock'),
      reporterSocketPath: join(ctx.dir, 'atc.sock'),
      eventsSocketPath: join(ctx.dir, 'atc-events.sock'),
      listenPort: null,
    },
    daemonExitCode: null,
  });
});
