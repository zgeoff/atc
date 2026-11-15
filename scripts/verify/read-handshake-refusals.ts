import { WringerError } from '@wringer/core';
import type { StreamClient } from '@wringer/stream';
import { collectHandshakeRefusals } from './collect-handshake-refusals.ts';
import type { HandshakeRefusal } from './collect-handshake-refusals.ts';
import { readStreamLines } from './read-stream-lines.ts';

// The listener logs a refusal after it closes the connection, which can come after the gateway's
// call has answered, so a read waits this long for it.
const SETTLE_MS = 5000;

// Reads the handshakes the daemon's TCP listener refused since `use` last marked the `daemon`
// stream, and fails with `check-failed` when it logged none within the settle time.
export async function readHandshakeRefusals(
  client: StreamClient,
): Promise<{ refusals: HandshakeRefusal[] }> {
  const deadline = Date.now() + SETTLE_MS;

  for (;;) {
    const lines = await readStreamLines(client, 'daemon');

    const refusals = collectHandshakeRefusals(lines);

    if (refusals.length > 0) {
      return { refusals };
    }

    if (Date.now() >= deadline) {
      throw new WringerError('check-failed', {
        message: 'the daemon logged no refused handshake since `use --feature`',
      });
    }

    await Bun.sleep(200);
  }
}
