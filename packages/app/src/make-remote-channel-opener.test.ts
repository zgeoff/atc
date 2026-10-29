import { expect, mock, test } from 'bun:test';
import type { RemoteDaemon } from '@atc/config';
import { makeRemoteChannelOpener } from './make-remote-channel-opener';
import { buildMockRemoteDaemon } from './test-utils/build-mock-remote-daemon';

test('it boots the daemon as the principal a channel asks for', async () => {
  const bootDaemon = mock<(daemon: RemoteDaemon) => Promise<{ client: string }>>(() =>
    Promise.resolve({ client: 'the web panel channel' }),
  );

  const daemon = buildMockRemoteDaemon({ name: 'box', principal: 'laptop' });
  const openChannel = makeRemoteChannelOpener(daemon, bootDaemon);

  await openChannel('web-panel');

  expect(bootDaemon).toHaveBeenCalledExactlyOnceWith({ ...daemon, principal: 'web-panel' });
});

test('it opens the channel the boot gives', () => {
  const openChannel = makeRemoteChannelOpener(
    buildMockRemoteDaemon({ name: 'box', principal: 'laptop' }),
    () => Promise.resolve({ client: 'the web panel channel' }),
  );

  expect(openChannel('web-panel')).resolves.toBe('the web panel channel');
});
