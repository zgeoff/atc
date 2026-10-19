import { writeFileSync } from 'node:fs';
import { openDaemonClient } from '@atc/protocol/client';
import type { DaemonClient } from '@atc/protocol/client';
import { DaemonError } from '@atc/protocol/wire';

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

  const outcome = await tryProbe(probe, socketPath, session);

  writeFileSync(outPath, JSON.stringify(outcome));
}

async function tryProbe(
  probe: string,
  socketPath: string,
  session: string,
): Promise<Readonly<Record<string, unknown>>> {
  const client = await openDaemonClient(socketPath);

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

  if (probe === 'message' || probe === 'message-as') {
    const params = { session, text: 'is the build green?', from: 'someone-else' };

    const sent =
      probe === 'message'
        ? await client.sendRequest('session.message', params)
        : await client.sendRequest('session.message', params, 'client-7', 'Lantern Notes');

    const read = await client.sendRequest('message.get', { message: sent['message'] });

    return { from: read['from'], sender: read['sender'] };
  }

  throw new Error(`unknown probe '${probe}'`);
}

await main();
