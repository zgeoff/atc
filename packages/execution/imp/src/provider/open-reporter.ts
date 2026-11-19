import { setTimeout as sleep } from 'node:timers/promises';
import type { HarnessRelay, HarnessSpec } from '@atc/plugin-api';
import { createLineDecoder } from '@atc/protocol/wire';
import { match } from 'ts-pattern';
import type { ImpHost } from '../port/imp-host';
import type { ImpForwardEnd, ImpPort, ImpRelayConnection } from '../port/imp-port';
import { buildReporterSocketBase } from './build-reporter-socket-base';

interface ReporterContext {
  readonly port: ImpPort;
  readonly guestDir: string;
  readonly reconnectDelaysMs: readonly number[];
}

// impd ends a forward for good when its tunnel socket closes, so the reporter listens again on
// the same path while the harness runs. A forward ended by the imp's sleep stays ended, because
// a listen would wake the sleeping imp.
export function openReporter(context: ReporterContext, host: ImpHost, spec: HarnessSpec) {
  const base = buildReporterSocketBase(context.guestDir, spec.session);
  const path = `${base}.sock`;
  const onRelay = spec.onRelay;

  const stopping = new AbortController();

  const openForward = () =>
    context.port.openReverseForward(host.name, path, (connection) => {
      onRelay?.(toHarnessRelay(connection));
    });

  let current = openForward();

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

  // A listen during a sleep the provider asked for wakes the imp again, so hooks must not listen
  // until impd has refused the sleep.
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

function toHarnessRelay(connection: ImpRelayConnection): HarnessRelay {
  const decoder = createLineDecoder();

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
