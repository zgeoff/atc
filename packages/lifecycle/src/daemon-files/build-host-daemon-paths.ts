import type { DaemonPaths } from '@atc/protocol';
import type { LifecycleHost } from '../boot/types';

export function buildHostDaemonPaths(host: LifecycleHost): DaemonPaths {
  return {
    socketPath: host.paths.daemonSocketPath,
    recordFile: host.paths.daemonRecordFile,
    pidFile: host.paths.daemonPidFile,
  };
}
