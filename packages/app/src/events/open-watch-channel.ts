import type { DaemonClient } from '@atc/protocol/client';
import { createDaemonClient } from '@atc/protocol/client';

// Each viewer gets its own daemon connection, so a viewer that lags holds back nothing the
// tools or another viewer wait on. The daemon treats a hello with no principal as its owner.
export async function openWatchChannel(
  socketPath: string,
  build: string,
  principal: string | null,
): Promise<DaemonClient> {
  const client = createDaemonClient(socketPath);
  const hello = principal === null ? {} : { principal };

  try {
    await client.sendHello(build, hello);
  } catch (error) {
    client.stop();
    throw error;
  }

  return client;
}
