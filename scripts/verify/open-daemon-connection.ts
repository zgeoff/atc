import { openDaemonClient } from '@atcx/contract/client';
import type { DaemonClient } from '@atcx/contract/client';

// A client of the daemon at the socket, past its handshake, that a `using` declaration closes.
export async function openDaemonConnection(socket: string): Promise<DaemonClient & Disposable> {
  const client = await openDaemonClient(socket);

  const connection = Object.assign(client, {
    [Symbol.dispose]: () => {
      client.stop();
    },
  });

  try {
    await client.sendHello('atc-verify');
  } catch (error) {
    client.stop();
    throw error;
  }

  return connection;
}
