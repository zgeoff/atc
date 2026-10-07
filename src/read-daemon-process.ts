import { readFileSync, readlinkSync, statSync } from 'node:fs';
import { buildOwnDaemonProcess } from './build-own-daemon-process';
import { collectRestartEnv } from './collect-restart-env';
import type { DaemonProcess } from './daemon-process';
import { parseDaemonFlags } from './parse-daemon-flags';

/**
 * Reads what a running daemon was started with from `/proc/<pid>`: its
 * environment, its working directory, and the listener flags on its command
 * line. Where `/proc` has no entry for it, as on macOS, the environment is
 * this process's own and the flags are empty.
 */
export function readDaemonProcess(pid: number): DaemonProcess {
  let environ: string;
  let cmdline: string;

  try {
    environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return buildOwnDaemonProcess();
  }

  const env: Record<string, string> = {};

  for (const entry of environ.split('\0')) {
    const eq = entry.indexOf('=');

    if (eq > 0) {
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }

  return {
    env: collectRestartEnv(env),
    cwd: readCwd(pid),
    flags: parseDaemonFlags(cmdline),
    fromProc: true,
  };
}

function readCwd(pid: number): string | null {
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`);

    return statSync(cwd).isDirectory() ? cwd : null;
  } catch {
    return null;
  }
}
