import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

// A server's OAuth issuer and resource name its port, and each must be in its flags and its service-token file before it starts, so the launcher picks the port first instead of asking for port 0.
export async function readFreePort(): Promise<number> {
  const server = createServer();

  server.listen(0, '127.0.0.1');

  await once(server, 'listening');

  const address: AddressInfo | string | null = server.address();

  server.close();

  await once(server, 'close');

  if (address === null || typeof address === 'string') {
    throw new Error('the loopback listener bound no TCP port');
  }

  return address.port;
}
