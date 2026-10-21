import { parseRestoreBootTimeoutMs } from '@atc/config';
import { resolvePaths } from '@atc/config/host';
import { systemClock } from '@atc/core';
import type { LifecycleHost } from '@atc/lifecycle';
import { readManagedDaemonUnit, runSystemctl, tryOpenDaemon } from '@atc/lifecycle';
import type { HostServices } from '@atc/plugin-api';
import { buildATCInvocation } from './build-atc-invocation';

export function buildLifecycleHost(
  env: Readonly<Record<string, string | undefined>>,
  services: HostServices,
): LifecycleHost {
  return {
    invocation: buildATCInvocation(services),
    paths: resolvePaths(env),
    clock: systemClock,

    // a test moves the /proc reads to place a daemon in a unit without a user
    // manager
    procRoot: env['ATC_PROC_ROOT'] ?? '/proc',
    restoreBootTimeoutMs: parseRestoreBootTimeoutMs(env),
    findManagedUnit: () => readManagedDaemonUnit(env),
    runSystemctl,
    openDaemon: tryOpenDaemon,
  };
}
