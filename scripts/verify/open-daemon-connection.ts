import { openDaemonClient } from '@atc/protocol/client';
import type { DaemonClient } from '@atc/protocol/client';

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
