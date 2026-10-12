import { systemClock } from '@atc/core/system-clock';
import type { Clock } from '@atc/core/system-clock';
import { waitUntil } from '@atc/core/wait-until';
import { DaemonClient } from './client/daemon-client';
import { DaemonError } from './protocol/daemon-error';
import { daemonRecordFile } from './shared/config';
import { findDaemonRecord } from './shared/find-daemon-record';
import { getBuild } from './shared/get-build';
import { isProcessAlive } from './shared/is-process-alive';

type ReplacementOutcome =
  | {
      readonly ok: true;
      readonly client: DaemonClient;
      readonly pid: number;
      readonly build: string;
      readonly listenPort: number | null;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Waits up to `waitMs` on the clock for a daemon to answer whose pid differs
 * from the one that was stopped and whose record in the state directory
 * matches it. With `expectedBuild`, the answering daemon must run that
 * build: another client that won the start with a different build is a
 * failure.
 */
export async function waitForReplacement(
  oldPID: number | null,
  expectedBuild: string | null,
  waitMs: number,
  clock: Clock = systemClock,
): Promise<ReplacementOutcome> {
  const deadline = clock.now() + waitMs;

  // The answer that ends the wait, and the last handshake a replacement
  // refused.
  const settled: { outcome?: ReplacementOutcome; refusal?: string } = {};

  await waitUntil(
    async () => {
      const record = findDaemonRecord(daemonRecordFile);

      if (record === null || record.pid === oldPID || !isProcessAlive(record.pid)) {
        return false;
      }

      const attempt = await tryHello(record.socketPath, deadline, clock);

      if (attempt.kind === 'refused') {
        settled.refusal = attempt.message;
      }

      if (attempt.kind !== 'ok') {
        return false;
      }

      if (expectedBuild !== null && attempt.build !== expectedBuild) {
        attempt.client.stop();

        settled.outcome = {
          ok: false,
          reason: `the daemon that came up (pid ${record.pid}) runs build ${attempt.build}, not ${expectedBuild}; another client started it first`,
        };

        return true;
      }

      settled.outcome = {
        ok: true,
        client: attempt.client,
        pid: record.pid,
        build: attempt.build,
        listenPort: record.listenPort,
      };

      return true;
    },
    { clock, intervalMs: 100, deadlineMs: deadline },
  );

  return (
    settled.outcome ?? {
      ok: false,
      reason:
        settled.refusal === undefined
          ? `no replacement daemon answered within ${Math.round(waitMs / 1000)} s`
          : `the replacement daemon refused the handshake: ${settled.refusal}`,
    }
  );
}

type Hello =
  | { readonly kind: 'ok'; readonly client: DaemonClient; readonly build: string }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'none' };

async function tryHello(socketPath: string, deadline: number, clock: Clock): Promise<Hello> {
  let client: DaemonClient;

  try {
    client = await DaemonClient.open(socketPath);
  } catch {
    return { kind: 'none' };
  }

  // A daemon that accepts the socket and never answers must not outlast the
  // startup deadline: closing the client rejects the handshake.
  const cancelExpiry = clock.schedule(
    () => {
      client.stop();
    },
    Math.max(0, deadline - clock.now()),
  );

  try {
    const hello = await client.sendHello(getBuild());

    const build = hello['daemon'];

    return { kind: 'ok', client, build: typeof build === 'string' ? build : 'unknown' };
  } catch (error) {
    client.stop();

    return error instanceof DaemonError && error.code === 'protocol_mismatch'
      ? { kind: 'refused', message: error.message }
      : { kind: 'none' };
  } finally {
    cancelExpiry();
  }
}
