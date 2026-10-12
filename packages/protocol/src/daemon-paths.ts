/**
 * The files that locate a running daemon: the socket this environment
 * computes, the record the daemon writes in its state directory, and its
 * pid file.
 */
export interface DaemonPaths {
  readonly socketPath: string;
  readonly recordFile: string;
  readonly pidFile: string;
}
