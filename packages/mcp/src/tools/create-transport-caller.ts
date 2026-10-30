import { readSessionEnv } from '@atc/protocol/session';
import type { DaemonChannel } from '@atc/protocol/wire';
import { createChannelCaller } from './create-channel-caller';
import type { ChannelCaller } from './create-channel-caller';

// each channel is handshaken before a request rides it, claiming the session the
// caller runs inside, which takes the answer notices of the messages it sends;
// null claims none.
export function createTransportCaller(
  socketPath: string | (() => Promise<string>),
  build: string,
  openChannel: (socketPath: string) => Promise<DaemonChannel>,
  session: string | null = readSessionEnv(process.env).sessionID ?? null,
): ChannelCaller {
  return createChannelCaller(() => openHandshaken(socketPath, build, openChannel, session));
}

// Opens a connection and handshakes it, closing one whose handshake fails.
async function openHandshaken(
  socketPath: string | (() => Promise<string>),
  build: string,
  openChannel: (socketPath: string) => Promise<DaemonChannel>,
  session: string | null,
): Promise<DaemonChannel> {
  const resolved = typeof socketPath === 'string' ? socketPath : await socketPath();

  const client = await openChannel(resolved);

  const options = session === null ? {} : { session };

  try {
    await client.sendHello(build, options);
  } catch (error) {
    client.stop();
    throw error;
  }

  return client;
}
