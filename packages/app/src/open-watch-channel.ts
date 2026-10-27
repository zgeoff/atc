import type { DaemonClient } from '@atc/protocol/client';
import { openDaemonClient } from '@atc/protocol/client';

// A live-terminal viewer's own connection, handshaken as the principal it
// watches for, so a viewer that lags holds back nothing the tools or another
// viewer wait on. A null principal is the daemon's owner.
export async function openWatchChannel(
  socketPath: string,
  build: string,
  principal: string | null,
): Promise<DaemonClient> {
  const client = await openDaemonClient(socketPath);

  const hello = principal === null ? {} : { principal };

  try {
    await client.sendHello(build, hello);
  } catch (error) {
    client.stop();
    throw error;
  }

  return client;
}
