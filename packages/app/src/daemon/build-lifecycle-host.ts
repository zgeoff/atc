import { parseRestoreBootTimeoutMs } from '@atc/config';
import { resolvePaths } from '@atc/config/host';
import { systemClock } from '@atc/core';
import type { LifecycleHost } from '@atc/lifecycle';
import { readManagedDaemonUnit, runSystemctl, tryOpenDaemon } from '@atc/lifecycle';
import type { HostServices } from '@atc/plugin-api';
import { buildATCInvocation } from '../cli/build-atc-invocation';

export function buildLifecycleHost(
  env: Readonly<Record<string, string | undefined>>,
  services: HostServices,
): LifecycleHost {
  return {
    invocation: buildATCInvocation(services),
    paths: resolvePaths(env),
    clock: systemClock,

    // Tests point this at a fake /proc tree to simulate a daemon in a unit with no user manager.
    procRoot: env['ATC_PROC_ROOT'] ?? '/proc',
    restoreBootTimeoutMs: parseRestoreBootTimeoutMs(env),
    findManagedUnit: () => readManagedDaemonUnit(env),
    runSystemctl,
    openDaemon: tryOpenDaemon,
  };
}
