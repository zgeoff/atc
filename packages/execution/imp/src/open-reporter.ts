import { setTimeout as sleep } from 'node:timers/promises';
import type { HarnessRelay, HarnessSpec } from '@atc/plugin-api';
import { LineDecoder } from '@atc/protocol/wire';
import { match } from 'ts-pattern';
import { buildShortName } from './build-short-name';
import type { ImpHost } from './imp-host';
import type { ImpForwardEnd, ImpPort, ImpRelayConnection } from './imp-port';

// What a reporter needs of the provider that opens it.
interface ReporterContext {
  readonly port: ImpPort;
  readonly guestDir: string;
  readonly reconnectDelaysMs: readonly number[];
}

// impd ends a forward for good when its tunnel socket closes, so one that ends
// before the harness listens again on the same path. A forward the imp's sleep
// ended stays ended, since a listen wakes a sleeping imp.
export function openReporter(context: ReporterContext, host: ImpHost, spec: HarnessSpec) {
  const base = `${context.guestDir}/run/${buildSocketName(spec.session)}`;
  const path = `${base}.sock`;
  const onRelay = spec.onRelay;

  const stopping = new AbortController();

  const openForward = () =>
    context.port.openReverseForward(host.name, path, (connection) => {
      onRelay?.(toHarnessRelay(connection));
    });

  let current = openForward();

  // Settles true once a sleep or destroy the provider asked for fails, so
  // the imp stays awake, and false once the reporter stops first.
  const waitForRefusedSleep = () =>
    new Promise<boolean>((resolve) => {
      if (stopping.signal.aborted) {
        resolve(false);

        return;
      }

      const onAbort = () => {
        host.sleepRefusals.delete(onRefusal);

        resolve(false);
      };

      const onRefusal = () => {
        stopping.signal.removeEventListener('abort', onAbort);

        resolve(true);
      };

      host.sleepRefusals.add(onRefusal);
      stopping.signal.addEventListener('abort', onAbort, { once: true });
    });

  // A listen during a sleep the provider asked for would wake the imp, so
  // the forward waits for the sleep's outcome and listens again only when
  // impd refuses it.
  const waitForAwakeHost = (): Promise<boolean> => {
    if (!host.suspending) {
      return Promise.resolve(true);
    }

    host.log?.(
      `imp ${host.name} is going to sleep; session ${spec.session}'s hooks listen again if the sleep is refused`,
    );

    return waitForRefusedSleep();
  };

  const restoreForward = async (): Promise<void> => {
    let failures = 0;

    for (;;) {
      const end = await current.ended;

      if (stopping.signal.aborted || end.kind === 'stopped') {
        return;
      }

      // A forward impd ended with an error can keep its tunnel socket open.
      current.stop();

      if (end.kind === 'lost') {
        host.log?.(
          `imp ${host.name} stopped listening for session ${spec.session}'s hooks (${formatForwardEnd(end)}); a wake listens again`,
        );

        return;
      }

      if (!(await waitForAwakeHost())) {
        return;
      }

      const delay =
        context.reconnectDelaysMs[Math.min(failures, context.reconnectDelaysMs.length - 1)] ?? 0;

      failures += 1;

      host.log?.(
        `imp ${host.name} stopped listening for session ${spec.session}'s hooks (${formatForwardEnd(end)}); listening again in ${delay}ms`,
      );

      try {
        await sleep(delay, undefined, { signal: stopping.signal, ref: false });
      } catch {
        return;
      }

      // The harness can end in the turn that settles the wait, before this
      // continuation runs, and a forward opened then has no stop to reach it.
      if (!(await waitForAwakeHost()) || stopping.signal.aborted) {
        return;
      }

      current = openForward();

      try {
        await current.listening;

        failures = 0;
      } catch {
        // Its end follows, and takes the next delay.
      }
    }
  };

  void restoreForward();

  // Notes and answers the guest has not seen answered wait in the outbox beside
  // the socket, for the next connection to send again.
  return {
    path,
    outbox: `${base}.outbox`,
    listening: current.listening,
    stop: () => {
      stopping.abort();
      current.stop();
    },
  };
}

// Short enough that the socket's path stays inside a unix socket's limit.
function buildSocketName(sessionID: string): string {
  return buildShortName(sessionID, 16);
}

// Frames a guest connection's bytes into lines, both ways.
function toHarnessRelay(connection: ImpRelayConnection): HarnessRelay {
  const decoder = new LineDecoder();
  const encoder = new TextEncoder();

  const lineListeners: ((line: string) => void)[] = [];

  connection.onData((data) => {
    for (const line of decoder.splitChunk(data)) {
      for (const listener of lineListeners) {
        listener(line);
      }
    }
  });

  return {
    onLine: (listener) => {
      lineListeners.push(listener);
    },
    onClose: (listener) => {
      connection.onClose(listener);
    },
    onEnd: (listener) => {
      connection.onEnd(listener);
    },
    writeLine: (line) => connection.write(encoder.encode(`${line}\n`)),
    close: () => {
      connection.close();
    },
  };
}

function formatForwardEnd(end: Exclude<ImpForwardEnd, { kind: 'stopped' }>): string {
  return match(end)
    .with({ kind: 'lost' }, () => 'the imp went away')
    .with({ kind: 'closed' }, (closed) =>
      closed.reason === '' ? `closed ${closed.code}` : `closed ${closed.code}: ${closed.reason}`,
    )
    .with(
      { kind: 'failed' },
      (failed) => `refused ${failed.code ?? 'without a code'}: ${failed.message}`,
    )
    .exhaustive();
}
