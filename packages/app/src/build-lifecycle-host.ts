import { parseRestoreBootTimeoutMs } from '@atc/config/parse-restore-boot-timeout-ms';
import { resolvePaths } from '@atc/config/resolve-paths';
import { systemClock } from '@atc/core/system-clock';
import type { LifecycleHost } from '@atc/lifecycle/lifecycle-host';
import { readManagedDaemonUnit } from '@atc/lifecycle/read-managed-daemon-unit';
import { runSystemctl } from '@atc/lifecycle/run-systemctl';
import { buildATCInvocation } from './build-atc-invocation';

/**
 * The host the daemon's process control runs against in this process: this
 * build's invocation, the paths and the restore boot time `env` gives, the
 * wall clock, the user unit lookup, and `systemctl --user`. `ATC_PROC_ROOT` moves the `/proc`
 * reads to another directory, so a test can place a daemon in a unit
 * without a user manager.
 */
export function buildLifecycleHost(
  env: Readonly<Record<string, string | undefined>>,
): LifecycleHost {
  return {
    invocation: buildATCInvocation(),
    paths: resolvePaths(env),
    clock: systemClock,
    procRoot: env['ATC_PROC_ROOT'] ?? '/proc',
    restoreBootTimeoutMs: parseRestoreBootTimeoutMs(env),
    findManagedUnit: () => readManagedDaemonUnit(),
    runSystemctl,
  };
}
