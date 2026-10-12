import type { LifecycleHost } from './lifecycle-host';
import { stopDaemonProcess } from './stop-daemon-process';

// The daemon to take out of service, and the user service whose main
// process it is, or null when no service runs it.
interface DaemonTarget {
  readonly pid: number;
  readonly unit: string | null;
}

type DaemonRestartStep =
  | { readonly kind: 'unit' }
  | { readonly kind: 'stopped'; readonly killed: boolean };

/**
 * Takes a daemon out of service so a daemon of this build can take its
 * place. A daemon a user service runs is restarted by the service manager,
 * through the host's `systemctl`, which starts the replacement too, and a
 * failed restart rejects with the manager's output. Any other daemon gets
 * SIGTERM and, when it still runs after the stop's wait, SIGKILL, and the
 * caller starts the replacement. The waits run on the host's clock.
 */
export async function restartDaemonProcess(
  target: DaemonTarget,
  host: Pick<LifecycleHost, 'clock' | 'runSystemctl'>,
): Promise<DaemonRestartStep> {
  if (target.unit !== null) {
    const restarted = await host.runSystemctl(['restart', target.unit]);

    if (restarted.code !== 0) {
      throw new Error(`systemctl restart ${target.unit} failed: ${restarted.stderr}`);
    }

    return { kind: 'unit' };
  }

  const stopped = await stopDaemonProcess(target.pid, host.clock);

  return { kind: 'stopped', killed: stopped === 'killed' };
}
