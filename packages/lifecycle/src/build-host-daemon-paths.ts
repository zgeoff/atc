import type { DaemonPaths } from '@atc/protocol/daemon-paths';
import type { LifecycleHost } from './lifecycle-host';

/**
 * The files that locate the daemon the host's paths start: the socket its
 * environment computes, the daemon's record, and its pid file.
 */
export function buildHostDaemonPaths(host: LifecycleHost): DaemonPaths {
  return {
    socketPath: host.paths.daemonSocketPath,
    recordFile: host.paths.daemonRecordFile,
    pidFile: host.paths.daemonPidFile,
  };
}
