import type { LifecycleHost } from '../boot/types';
import { stopDaemonProcess } from '../daemon-process/stop-daemon-process';

interface DaemonTarget {
  readonly pid: number;
  readonly unit: string | null;
}

type DaemonRestartStep =
  | { readonly kind: 'unit' }
  | { readonly kind: 'stopped'; readonly killed: boolean };

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
