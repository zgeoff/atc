import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolvePaths } from '@atc/config';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { createDaemonClient } from '@atc/protocol/client';
import { CONTRACT_MAJOR } from '@atcx/contract/light';
import invariant from 'tiny-invariant';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-mcp-http-wait-');

  const env = {
    ...process.env,
    HOME: temporaryDirectory.path,
    XDG_RUNTIME_DIR: temporaryDirectory.path,
  };

  return {
    directory: temporaryDirectory.path,
    paths: resolvePaths(env),
    atc: resolveATCCommand(),
    env,
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

  // The server prints its wait line once it has found no daemon and begun to wait, so the daemon must start after that.
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

  const port = await waitFor(() => {
    const bound = /listening on http:\/\/127\.0\.0\.1:(?<port>\d+)\n/u.exec(stdout)?.groups?.[
      'port'
    ];

    invariant(bound !== undefined, `no serving line on stdout yet: ${stdout}`);

    return bound;
  });

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });

  const record = await waitFor((): unknown =>
    JSON.parse(readFileSync(ctx.paths.daemonRecordFile, 'utf8')),
  );

  // The server prints its no-clients and no-passkey lines after it opens
  // the auth database, so the stop waits for the last of them.
  await waitFor(() => {
    expect(stdout).toEndWith('atc passkeys enroll\n');
  });

  mcp.kill('SIGTERM');

  await mcp.exited;
  await drained;

  const client = createDaemonClient(ctx.paths.daemonSocketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  expect(stderr).toMatch(
    /^atc mcp --http: no daemon answers yet; waiting up to 30s for one, without starting it\natc security \{[^\n]*"reason":"missing"[^\n]*\}\nPOST \/mcp 401 \d+ms\n$/u,
  );

  expect(stdout).toBe(
    `atc mcp --http: serving http://127.0.0.1:${port}/mcp, listening on http://127.0.0.1:${port}\nNo clients can connect yet. Add one with: atc clients add <name> --redirect-uri <uri>\nNo passkey is enrolled, so nobody can sign in yet. Enroll one with: atc passkeys enroll\n`,
  );

  expect(Number(port)).toBeGreaterThan(0);
  expect(response.status).toBe(401);

  expect(record).toStrictEqual({
    pid: daemon.pid,
    socketPath: ctx.paths.daemonSocketPath,
    reporterSocketPath: ctx.paths.socketPath,
    eventsSocketPath: ctx.paths.eventsSocketPath,
    listenPort: null,
    protocol: 15,
    major: CONTRACT_MAJOR,
  });

  expect(Bun.peek.status(daemon.exited)).toBe('pending');
});
