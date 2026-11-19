import { readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseDaemonFlags } from '../boot/parse-daemon-flags';
import { collectRestartEnv } from '../restart/collect-restart-env';
import { readOwnDaemonProcess } from './read-own-daemon-process';
import { readProcProcess } from './read-proc-process';
import type { DaemonProcess } from './types';

export function readDaemonProcess(pid: number, procRoot: string): DaemonProcess {
  const subprocess = readProcProcess(procRoot, pid);

  // macOS has no readable /proc entry for a process, so fall back to this process's own start.
  if (subprocess === null) {
    return readOwnDaemonProcess();
  }

  return {
    env: collectRestartEnv(subprocess.env),
    cwd: readCwd(procRoot, pid),
    flags: parseDaemonFlags(subprocess.args),
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
