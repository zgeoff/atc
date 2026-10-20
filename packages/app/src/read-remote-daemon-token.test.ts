import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildStubForkingGH, createStubBin, setupTempDir, waitFor } from '@atc/test-utils';
import { readRemoteDaemonToken } from './read-remote-daemon-token';
import { buildMockRemoteDaemon } from './test-utils/build-mock-remote-daemon';

function setupTest() {
  const tmp = setupTempDir('atc-remote-token-');

  return { dir: tmp.path, tokenFile: join(tmp.path, 'box.token') };
}

test('it reads the token a file holds, without its final newline', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'t'.repeat(32)}\n`);

  const token = await readRemoteDaemonToken(
    buildMockRemoteDaemon({ name: 'box', token: { kind: 'file', path: ctx.tokenFile } }),
  );

  expect(token).toBe('t'.repeat(32));
});

test('it reads the token a command prints', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'c'.repeat(32)}\n`);

  const token = await readRemoteDaemonToken(
    buildMockRemoteDaemon({
      name: 'box',
      token: { kind: 'command', argv: ['cat', ctx.tokenFile] },
    }),
  );

  expect(token).toBe('c'.repeat(32));
});

test('it rejects a token file it cannot read, with the daemon and the path', () => {
  const ctx = setupTest();
  const missing = join(ctx.dir, 'missing.token');

  expect(
    readRemoteDaemonToken(
      buildMockRemoteDaemon({ name: 'box', token: { kind: 'file', path: missing } }),
    ),
  ).rejects.toThrowWithMessage(
    Error,
    `daemon 'box': cannot read its token file ${missing} (ENOENT)`,
  );
});

test('it rejects a token file that holds two lines, without either line in the message', () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n${'b'.repeat(32)}\n`);

  expect(
    readRemoteDaemonToken(
      buildMockRemoteDaemon({ name: 'box', token: { kind: 'file', path: ctx.tokenFile } }),
    ),
  ).rejects.toThrowWithMessage(
    Error,
    `daemon 'box': its token file ${ctx.tokenFile} must hold one token on one line`,
  );
});

test('it rejects an empty token file', () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, '\n');

  expect(
    readRemoteDaemonToken(
      buildMockRemoteDaemon({ name: 'box', token: { kind: 'file', path: ctx.tokenFile } }),
    ),
  ).rejects.toThrowWithMessage(
    Error,
    `daemon 'box': its token file ${ctx.tokenFile} must hold one token on one line`,
  );
});

test('it rejects a command that exits non-zero, without its output in the message', () => {
  expect(
    readRemoteDaemonToken(
      buildMockRemoteDaemon({
        name: 'box',
        token: { kind: 'command', argv: ['sh', '-c', 'echo not-a-real-token; exit 3'] },
      }),
    ),
  ).rejects.toThrowWithMessage(Error, "daemon 'box': its token command sh exited 3");
});

test('it stops a command whose child keeps its output open once the deadline passes', async () => {
  const ctx = setupTest();
  const pidsFile = join(ctx.dir, 'pids');
  const bin = createStubBin(ctx.dir, 'forking-helper', buildStubForkingGH(pidsFile));
  const started = performance.now();

  const rejection = await readRemoteDaemonToken(
    buildMockRemoteDaemon({ name: 'box', token: { kind: 'command', argv: [bin] } }),
    { timeoutMs: 1000 },
  ).then(
    () => null,
    (error: unknown) => error,
  );

  const elapsedMs = performance.now() - started;

  const pids = await readFile(pidsFile, 'utf8');

  const [group, child] = pids.trim().split('\n');

  expect(rejection).toBeInstanceOf(Error);

  expect(rejection).toHaveProperty(
    'message',
    `daemon 'box': its token command ${bin} ran past 1000 ms`,
  );

  // The child sleeps for 30 s, so a read that waits on it ends far later.
  expect(elapsedMs).toBeLessThan(5000);

  // The killed group's processes linger until the kernel reaps them, and a
  // child that escaped the kill would outlive this wait by far.
  await waitFor(
    () => {
      expect(() => process.kill(-Number(group), 0)).toThrow('ESRCH');
      expect(() => process.kill(Number(child), 0)).toThrow('ESRCH');
    },
    { timeoutMs: 3000 },
  );
});

test('it stops a command that exits while its child keeps its output open once the deadline passes', async () => {
  const ctx = setupTest();
  const pidFile = join(ctx.dir, 'child.pid');

  const rejection = await readRemoteDaemonToken(
    buildMockRemoteDaemon({
      name: 'box',
      token: { kind: 'command', argv: ['sh', '-c', `sleep 30 & echo $! > '${pidFile}'`] },
    }),
    { timeoutMs: 1000 },
  ).then(
    () => null,
    (error: unknown) => error,
  );

  const pid = await readFile(pidFile, 'utf8');

  expect(rejection).toBeInstanceOf(Error);

  expect(rejection).toHaveProperty(
    'message',
    "daemon 'box': its token command sh ran past 1000 ms",
  );

  // A killed child lingers until the kernel reaps it, and one that escaped the
  // kill would outlive this wait by far.
  await waitFor(
    () => {
      expect(() => process.kill(Number(pid), 0)).toThrow('ESRCH');
    },
    { timeoutMs: 3000 },
  );
});

test('it reads the token of a command whose child keeps stderr open after it exits', async () => {
  const ctx = setupTest();
  const pidFile = join(ctx.dir, 'child.pid');

  const token = await readRemoteDaemonToken(
    buildMockRemoteDaemon({
      name: 'box',
      token: {
        kind: 'command',
        argv: ['sh', '-c', `sleep 30 >/dev/null & echo $! > '${pidFile}'; printf token`],
      },
    }),
    { timeoutMs: 1000 },
  );

  // A read that timed out has already killed the child's process group.
  const pid = await readFile(pidFile, 'utf8');

  onTestFinished(() => {
    process.kill(Number(pid), 'SIGKILL');
  });

  expect(token).toBe('token');
});

test('it rejects a command that a signal kills with its exit code', () => {
  expect(
    readRemoteDaemonToken(
      buildMockRemoteDaemon({
        name: 'box',
        token: { kind: 'command', argv: ['sh', '-c', 'kill -TERM $$'] },
      }),
    ),
  ).rejects.toThrowWithMessage(Error, "daemon 'box': its token command sh exited 143");
});

test('it rejects a command that cannot start', () => {
  const ctx = setupTest();
  const helper = join(ctx.dir, 'no-such-helper');

  expect(
    readRemoteDaemonToken(
      buildMockRemoteDaemon({ name: 'box', token: { kind: 'command', argv: [helper] } }),
    ),
  ).rejects.toThrowWithMessage(Error, `daemon 'box': cannot run its token command ${helper}`);
});
