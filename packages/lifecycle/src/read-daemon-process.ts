import { readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildOwnDaemonProcess } from './build-own-daemon-process';
import { collectRestartEnv } from './collect-restart-env';
import type { DaemonProcess } from './daemon-process';
import { parseDaemonFlags } from './parse-daemon-flags';
import { readProcProcess } from './read-proc-process';

/**
 * Reads what a running daemon was started with from its entry under
 * `procRoot`: its environment, its working directory, and the listener
 * flags on its command line. Where the entry cannot be read, as on macOS,
 * the environment is this process's own and the flags are empty.
 */
export function readDaemonProcess(pid: number, procRoot: string): DaemonProcess {
  const proc = readProcProcess(procRoot, pid);

  if (proc === null) {
    return buildOwnDaemonProcess();
  }

  return {
    env: collectRestartEnv(proc.env),
    cwd: readCwd(procRoot, pid),
    flags: parseDaemonFlags(proc.args),
    fromProc: true,
  };
}

function readCwd(procRoot: string, pid: number): string | null {
  try {
    const cwd = readlinkSync(join(procRoot, String(pid), 'cwd'));

    return statSync(cwd).isDirectory() ? cwd : null;
  } catch {
    return null;
  }
}
