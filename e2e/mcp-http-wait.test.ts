import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { DaemonClient } from '../src/client/daemon-client';
import { registerTestCleanup } from '../src/test-utils/register-test-cleanup';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { waitFor } from '../src/test-utils/wait-for';

/**
 * A fresh home whose computed daemon socket sits in it, and the command atc
 * runs as with an environment that makes that home its home and runtime
 * directory. The home is removed once the test finishes.
 */
function setupTest() {
  const tmp = setupTempDir('atc-mcp-http-wait-');

  return {
    dir: tmp.dir,
    atc: resolveATCCommand(),
    env: { ...process.env, HOME: tmp.dir, XDG_RUNTIME_DIR: tmp.dir },
  };
}

test('it waits for a daemon started after it, starting none of its own, and serves through that daemon', async () => {
  const ctx = setupTest();

  const mcp = Bun.spawn([...ctx.atc, 'mcp', '--http', '--wait-for-daemon', '--port', '0'], {
    env: ctx.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  registerTestCleanup(async () => {
    mcp.kill();

    await mcp.exited;
  });

  let stderr = '';
  let stdout = '';

  const drained = Promise.all([
    (async () => {
      for await (const chunk of mcp.stderr) {
        stderr += new TextDecoder().decode(chunk);
      }
    })(),
    (async () => {
      for await (const chunk of mcp.stdout) {
        stdout += new TextDecoder().decode(chunk);
      }
    })(),
  ]);

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

  // The server prints its serving line on stdout once it serves, with the
  // port the kernel bound for port 0.
  const port = await waitFor(() => {
    const bound = /listening on http:\/\/127\.0\.0\.1:(?<port>\d+)\n/u.exec(stdout)?.groups?.[
      'port'
    ];

    invariant(bound !== undefined, `no serving line on stdout yet: ${stdout}`);

    return bound;
  });

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });

  const record = await waitFor((): unknown =>
    JSON.parse(readFileSync(join(ctx.dir, '.local', 'state', 'atc', 'daemon.json'), 'utf8')),
  );

  // The server prints its no-clients line after it opens the auth database,
  // so the stop waits for that line.
  await waitFor(() => {
    expect(stdout).toEndWith('--redirect-uri <uri>\n');
  });

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

  expect(stdout).toBe(
    `atc mcp --http: serving http://127.0.0.1:${port}/mcp, listening on http://127.0.0.1:${port}\nNo clients can connect yet. Add one with: atc clients add <name> --redirect-uri <uri>\n`,
  );

  expect(Number(port)).toBeGreaterThan(0);
  expect(response.status).toBe(401);

  expect(record).toStrictEqual({
    pid: daemon.pid,
    socketPath: join(ctx.dir, 'atc-daemon.sock'),
    reporterSocketPath: join(ctx.dir, 'atc.sock'),
    eventsSocketPath: join(ctx.dir, 'atc-events.sock'),
    listenPort: null,
  });

  expect(Bun.peek.status(daemon.exited)).toBe('pending');
});
