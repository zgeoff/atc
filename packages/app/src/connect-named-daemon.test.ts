import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMockAgentAdapter, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { connectNamedDaemon } from './connect-named-daemon';
import { buildMockRemoteDaemon } from './test-utils/build-mock-remote-daemon';
import { startTestDaemon } from './test-utils/start-test-daemon';

test('it lists the sessions of the daemon as the principal of its config entry', async () => {
  const temporaryDirectory = setupTempDir('atc-connect-named-');
  const tokenFile = join(temporaryDirectory.path, 'box.token');

  writeFileSync(tokenFile, `${'a'.repeat(32)}\n`);

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['laptop', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  invariant(remote.daemon.listenPort !== null, 'the remote daemon bound no TCP port');

  await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'on-the-box',
    cols: 80,
    rows: 24,
  });

  const connection = connectNamedDaemon(
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: remote.daemon.listenPort,
      token: { kind: 'file', path: tokenFile },
      principal: 'laptop',
    }),
    'atc/test-client',
  );

  onTestFinished(() => connection.caller.stop());

  const listed = await connection.caller.sendRequest('session.list');

  expect(listed['sessions']).toStrictEqual([expect.objectContaining({ name: 'on-the-box' })]);
});
