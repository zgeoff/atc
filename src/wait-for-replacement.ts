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
 * Waits up to `waitMs` for a daemon to answer whose pid differs from the one
 * that was stopped and whose record in the state directory matches it. With
 * `expectedBuild`, the answering daemon must run that build: another client
 * that won the start with a different build is a failure.
 */
export async function waitForReplacement(
  oldPID: number | null,
  expectedBuild: string | null,
  waitMs: number,
): Promise<ReplacementOutcome> {
  const deadline = Date.now() + waitMs;
  let refusal: string | null = null;

  while (Date.now() < deadline) {
    const record = findDaemonRecord(daemonRecordFile);

    if (record !== null && record.pid !== oldPID && isProcessAlive(record.pid)) {
      const attempt = await tryHello(record.socketPath);

      if (attempt.kind === 'ok') {
        if (expectedBuild !== null && attempt.build !== expectedBuild) {
          attempt.client.stop();

          return {
            ok: false,
            reason: `the daemon that came up (pid ${record.pid}) runs build ${attempt.build}, not ${expectedBuild}; another client started it first`,
          };
        }

        return {
          ok: true,
          client: attempt.client,
          pid: record.pid,
          build: attempt.build,
          listenPort: record.listenPort,
        };
      }

      if (attempt.kind === 'refused') {
        refusal = attempt.message;
      }
    }

    await Bun.sleep(100);
  }

  return {
    ok: false,
    reason:
      refusal === null
        ? `no replacement daemon answered within ${Math.round(waitMs / 1000)} s`
        : `the replacement daemon refused the handshake: ${refusal}`,
  };
}

type Hello =
  | { readonly kind: 'ok'; readonly client: DaemonClient; readonly build: string }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'none' };

async function tryHello(socketPath: string): Promise<Hello> {
  let client: DaemonClient;

  try {
    client = await DaemonClient.open(socketPath);
  } catch {
    return { kind: 'none' };
  }

  try {
    const hello = await client.sendHello(getBuild());

    const build = hello['daemon'];

    return { kind: 'ok', client, build: typeof build === 'string' ? build : 'unknown' };
  } catch (error) {
    client.stop();

    return error instanceof DaemonError && error.code === 'protocol_mismatch'
      ? { kind: 'refused', message: error.message }
      : { kind: 'none' };
  }
}
