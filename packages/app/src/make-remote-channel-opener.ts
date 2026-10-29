import type { RemoteDaemon } from '@atc/config';

// Each channel is a fresh boot of the daemon's client, which reads the token
// again, so a token rotated on the daemon's host reaches the next channel
// without a restart.
export function makeRemoteChannelOpener<Client>(
  daemon: RemoteDaemon,
  bootDaemon: (daemon: RemoteDaemon) => Promise<{ readonly client: Client }>,
): (principal: string) => Promise<Client> {
  return async (principal) => {
    const boot = await bootDaemon({ ...daemon, principal });

    return boot.client;
  };
}
