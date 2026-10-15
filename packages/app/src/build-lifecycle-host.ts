import { parseRestoreBootTimeoutMs } from '@atc/config';
import { resolvePaths } from '@atc/config/host';
import { systemClock } from '@atc/core';
import type { LifecycleHost } from '@atc/lifecycle';
import { readManagedDaemonUnit, runSystemctl } from '@atc/lifecycle';
import type { HostServices } from '@atc/plugin-api';
import { buildATCInvocation } from './build-atc-invocation';

/**
 * The host the daemon's process control runs against in this process: the
 * invocation `services` gives, the paths, the user unit directories, and the restore
 * boot time `env` gives, the wall clock, and `systemctl --user`. `ATC_PROC_ROOT` moves the `/proc`
 * reads to another directory, so a test can place a daemon in a unit
 * without a user manager.
 */
export function buildLifecycleHost(
  env: Readonly<Record<string, string | undefined>>,
  services: HostServices,
): LifecycleHost {
  return {
    invocation: buildATCInvocation(services),
    paths: resolvePaths(env),
    clock: systemClock,
    procRoot: env['ATC_PROC_ROOT'] ?? '/proc',
    restoreBootTimeoutMs: parseRestoreBootTimeoutMs(env),
    findManagedUnit: () => readManagedDaemonUnit(env),
    runSystemctl,
  };
}
