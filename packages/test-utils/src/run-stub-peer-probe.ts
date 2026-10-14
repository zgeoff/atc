import { writeFileSync } from 'node:fs';
import { DaemonClient } from '@atc/protocol/client/daemon-client';
import { DaemonError } from '@atc/protocol/daemon-error';

/**
 * Runs one probe of what the daemon lets a local client do, the way a
 * process inside a session would try it, and writes the outcome to a file
 * as JSON. Arguments: the probe, the socket path, a session id, and the
 * output path.
 *
 * - `scope-add` sends a handshake without a session and adds an empty scope
 *   to the session's record. It writes `{ "ok": true }`, or the refusal's
 *   `code`.
 * - `message` sends a handshake without a session and sends the session a
 *   message from `someone-else`. It writes the `from` that `message.get`
 *   reads back for it, or the refusal's `code`.
 * - `hello` sends a handshake that gives the session. It writes
 *   `{ "ok": true }`, or the refusal's `code`.
 * - `events` connects to the socket path as an events socket and waits for
 *   the daemon to close it, writing one empty line once it is connected. It
 *   writes how many bytes it read first, none when the close failed the
 *   connect.
 */
async function main() {
  const [probe, socketPath, session, outPath] = process.argv.slice(2);

  if (
    probe === undefined ||
    socketPath === undefined ||
    session === undefined ||
    outPath === undefined
  ) {
    throw new Error('usage: run-stub-peer-probe.ts <probe> <socket path> <session> <out path>');
  }

  const outcome =
    probe === 'events' ? await readEvents(socketPath) : await tryProbe(probe, socketPath, session);

  writeFileSync(outPath, JSON.stringify(outcome));
}

async function readEvents(socketPath: string): Promise<Readonly<Record<string, unknown>>> {
  const closed = Promise.withResolvers<void>();
  let bytes = 0;

  // A close that lands while the connect completes fails the connect itself
  // with a reset, which reads nothing as well. Any other failure, such as a
  // missing socket, stops the probe without an outcome.
  try {
    const socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_socket, buf) {
          bytes += buf.byteLength;
        },
        close() {
          closed.resolve();
        },
        error() {
          closed.resolve();
        },
      },
    });

    // The daemon ignores input on the events socket; the line tells a
    // stand-in listener that the connect completed.
    socket.write('\n');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ECONNRESET') {
      throw error;
    }

    closed.resolve();
  }

  await closed.promise;

  return { bytes };
}

async function tryProbe(
  probe: string,
  socketPath: string,
  session: string,
): Promise<Readonly<Record<string, unknown>>> {
  const client = await DaemonClient.open(socketPath);

  try {
    return await runProbe(client, probe, session);
  } catch (error) {
    if (error instanceof DaemonError) {
      return { code: error.code };
    }

    throw error;
  } finally {
    client.stop();
  }
}

async function runProbe(
  client: Readonly<Pick<DaemonClient, 'sendHello' | 'sendRequest'>>,
  probe: string,
  session: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (probe === 'hello') {
    await client.sendHello('atc/peer-probe', { session });

    return { ok: true };
  }

  await client.sendHello('atc/peer-probe');

  if (probe === 'scope-add') {
    await client.sendRequest('session.scope.add', { session, scope: {} });

    return { ok: true };
  }

  if (probe === 'message') {
    const sent = await client.sendRequest('session.message', {
      session,
      text: 'is the build green?',
      from: 'someone-else',
    });

    const read = await client.sendRequest('message.get', { message: sent['message'] });

    return { from: read['from'] };
  }

  throw new Error(`unknown probe '${probe}'`);
}

await main();
