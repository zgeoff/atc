import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../src/client/daemon-client';
import { registerTestCleanup } from '../src/test-utils/register-test-cleanup';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { waitFor } from '../src/test-utils/wait-for';

/**
 * A fresh home whose computed daemon socket sits in it, a free loopback port
 * for the HTTP server, and the command atc runs as with an environment that
 * makes that home its home and runtime directory. The home is removed once
 * the test finishes.
 */
function setupTest() {
  const tmp = setupTempDir('atc-mcp-http-wait-');

  // The CLI refuses port 0, so the server takes a port the kernel handed
  // out and released just before.
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  const port = probe.port;

  probe.stop(true);

  return {
    dir: tmp.dir,
    port,
    atc: resolveATCCommand(),
    env: { ...process.env, HOME: tmp.dir, XDG_RUNTIME_DIR: tmp.dir },
  };
}

test('it waits for a daemon started after it, starting none of its own, and serves through that daemon', async () => {
  const ctx = setupTest();

  const mcp = Bun.spawn(
    [...ctx.atc, 'mcp', '--http', '--wait-for-daemon', '--port', String(ctx.port)],
    { env: ctx.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );

  registerTestCleanup(async () => {
    mcp.kill();

    await mcp.exited;
  });

  let stderr = '';

  const drained = (async () => {
    for await (const chunk of mcp.stderr) {
      stderr += new TextDecoder().decode(chunk);
    }
  })();

  // The server prints its wait line once it has found no daemon and begun
  // to wait, so the daemon below starts after the wait has begun.
  await waitFor(() => {
    expect(stderr).toEndWith('\n');
  });

  const daemon = Bun.spawn([...ctx.atc, 'daemon'], {
    env: ctx.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(async () => {
    daemon.kill();

    await daemon.exited;
  });

  const served = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, { method: 'POST' });

    return response.status;
  });

  const record = await waitFor((): unknown =>
    JSON.parse(readFileSync(join(ctx.dir, '.local', 'state', 'atc', 'daemon.json'), 'utf8')),
  );

  mcp.kill('SIGTERM');

  await mcp.exited;
  await drained;

  // A handshake answered after the server stopped proves the daemon still
  // serves.
  const client = await DaemonClient.open(join(ctx.dir, 'atc-daemon.sock'));

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  expect(stderr).toMatch(
    /^atc mcp --http: no daemon answers yet; waiting up to 30s for one, without starting it\nPOST \/mcp 401 \d+ms\n$/u,
  );

  expect(served).toBe(401);

  expect(record).toStrictEqual({
    pid: daemon.pid,
    socketPath: join(ctx.dir, 'atc-daemon.sock'),
    reporterSocketPath: join(ctx.dir, 'atc.sock'),
    eventsSocketPath: join(ctx.dir, 'atc-events.sock'),
    listenPort: null,
  });

  expect(Bun.peek.status(daemon.exited)).toBe('pending');
});
