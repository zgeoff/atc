import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { readRemoteDaemonToken } from './read-remote-daemon-token';
import { buildMockRemoteDaemon } from './test-utils/build-mock-remote-daemon';

function setupTest() {
  const tmp = setupTempDir('atc-remote-token-');

  return { dir: tmp.dir, tokenFile: join(tmp.dir, 'box.token') };
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

test('it rejects a command that cannot start', () => {
  const ctx = setupTest();
  const helper = join(ctx.dir, 'no-such-helper');

  expect(
    readRemoteDaemonToken(
      buildMockRemoteDaemon({ name: 'box', token: { kind: 'command', argv: [helper] } }),
    ),
  ).rejects.toThrowWithMessage(Error, `daemon 'box': cannot run its token command ${helper}`);
});
