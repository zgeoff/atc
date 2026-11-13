import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMockLifecycleHost } from '@atc/lifecycle/testing';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { setupTempDir, startStubLegacyDaemon, takeFreePort } from '@atc/test-utils';
import { DaemonLinkFailureError } from '@atc/tui';
import invariant from 'tiny-invariant';
import { createRemoteDaemonEntry } from './create-remote-daemon-entry';
import { buildMockRemoteDaemon } from './test-utils/build-mock-remote-daemon';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-remote-entry-');
  const tokenFile = join(temporaryDirectory.path, 'box.token');

  writeFileSync(tokenFile, `${'a'.repeat(32)}\n`);

  return { tokenFile, host: buildMockLifecycleHost() };
}

test('it rejects with the kind down when the daemon is unreachable', () => {
  const ctx = setupTest();

  const entry = createRemoteDaemonEntry(
    ctx.host,
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: takeFreePort(),
      token: { kind: 'file', path: ctx.tokenFile },
    }),
  );

  expect(entry.bootDaemon()).rejects.toMatchObject({ kind: 'down' });
});

test('it rejects with the kind unauthorized when the token file cannot be read', () => {
  const ctx = setupTest();

  const entry = createRemoteDaemonEntry(
    ctx.host,
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: takeFreePort(),
      token: { kind: 'file', path: join(ctx.tokenFile, 'missing') },
    }),
  );

  expect(entry.bootDaemon()).rejects.toMatchObject({ kind: 'unauthorized' });
});

test('it rejects with the kind mismatched and the daemon text when the daemon speaks another protocol', async () => {
  const ctx = setupTest();

  const legacy = startStubLegacyDaemon(
    { hostname: '127.0.0.1', port: 0 },
    { protocol: PROTOCOL_V + 1 },
  );

  invariant(legacy.port !== null, 'the stub daemon bound no TCP port');

  const entry = createRemoteDaemonEntry(
    ctx.host,
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: legacy.port,
      token: { kind: 'file', path: ctx.tokenFile },
    }),
  );

  const failure = await entry.bootDaemon().catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(DaemonLinkFailureError);
  expect(failure).toMatchObject({ kind: 'mismatched' });
  expect(String(failure)).toInclude(`speaks v${PROTOCOL_V + 1}`);
});
