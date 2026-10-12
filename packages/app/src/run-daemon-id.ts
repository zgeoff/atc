import { DaemonClient } from './client/daemon-client';
import { daemonRecordFile, daemonSocketPath } from './shared/config';
import { findDaemonRecord } from './shared/find-daemon-record';

/**
 * Prints the running daemon's `daemonID`, the identity a gateway registry
 * pins, read from the handshake over the owner's local socket: the one this
 * environment computes, else the one the daemon recorded in the state
 * directory. When no daemon answers, prints a hint to stderr and exits
 * nonzero instead of booting one.
 */
export async function runDaemonID(build: string): Promise<void> {
  const record = findDaemonRecord(daemonRecordFile);
  const paths = [daemonSocketPath, ...(record === null ? [] : [record.socketPath])];

  for (const path of new Set(paths)) {
    const daemonID = await tryReadDaemonID(path, build);

    if (daemonID !== null) {
      console.log(daemonID);

      return;
    }
  }

  console.error(`atc daemon id: no daemon at ${daemonSocketPath} — start one first`);
  process.exit(1);
}

// The daemonID the daemon at the socket returns, or null when nothing
// answers there or the answer holds none.
async function tryReadDaemonID(socketPath: string, build: string): Promise<string | null> {
  let client: DaemonClient;

  try {
    client = await DaemonClient.open(socketPath);
  } catch {
    return null;
  }

  try {
    const hello = await client.sendHello(build);

    const daemonID = hello['daemonID'];

    return typeof daemonID === 'string' ? daemonID : null;
  } catch {
    return null;
  } finally {
    client.stop();
  }
}
