import { waitUntil } from '@atc/core';
import type { DaemonClient } from '@atc/protocol/client';
import { findDaemonRecord } from './find-daemon-record';
import { isProcessAlive } from './is-process-alive';
import type { LifecycleHost } from './lifecycle-host';
import { tryOpenDaemon } from './try-open-daemon';

type ReplacementOutcome =
  | {
      readonly ok: true;
      readonly client: Readonly<DaemonClient>;
      readonly pid: number;
      readonly build: string;
      readonly listenPort: number | null;
    }
  | { readonly ok: false; readonly reason: string };

export async function waitForReplacement(
  host: LifecycleHost,
  oldPID: number | null,
  expectedBuild: string | null,
  waitMs: number,
): Promise<ReplacementOutcome> {
  const clock = host.clock;
  const deadline = clock.now() + waitMs;

  // The answer that ends the wait, and the last handshake a replacement
  // refused.
  const settled: { outcome?: ReplacementOutcome; refusal?: string } = {};

  await waitUntil(
    async () => {
      const record = findDaemonRecord(host.paths.daemonRecordFile);

      if (record === null || record.pid === oldPID || !isProcessAlive(record.pid)) {
        return false;
      }

      // A daemon that accepts the socket and never answers must not outlast
      // the startup deadline.
      const attempt = await tryOpenDaemon(
        [record.socketPath],
        { build: host.invocation.readBuild(), deadline, clock, keepOpen: true },
        (client) => Promise.resolve(client),
      );

      if (attempt?.kind === 'refused') {
        settled.refusal = attempt.message;
      }

      if (attempt?.kind !== 'ok') {
        return false;
      }

      if (expectedBuild !== null && attempt.hello.build !== expectedBuild) {
        attempt.value.stop();

        settled.outcome = {
          ok: false,
          reason: `the daemon that came up (pid ${record.pid}) runs build ${attempt.hello.build}, not ${expectedBuild}; another client started it first`,
        };

        return true;
      }

      settled.outcome = {
        ok: true,
        client: attempt.value,
        pid: record.pid,
        build: attempt.hello.build,
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
