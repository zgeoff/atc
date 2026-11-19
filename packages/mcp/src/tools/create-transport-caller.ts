import { readSessionEnv } from '@atc/protocol/session';
import type { DaemonChannel } from '@atc/protocol/wire';
import { createChannelCaller } from './create-channel-caller';
import type { ChannelCaller } from './create-channel-caller';

// The handshake claims the session this caller runs inside, and the daemon delivers answer
// notices for the messages the caller sends to that session; null claims no session.
export function createTransportCaller(
  socketPath: string | (() => Promise<string>),
  build: string,
  openChannel: (socketPath: string) => Promise<DaemonChannel>,
  session: string | null = readSessionEnv(process.env).sessionID ?? null,
): ChannelCaller {
  return createChannelCaller(() => openHandshaken(socketPath, build, openChannel, session));
}

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
