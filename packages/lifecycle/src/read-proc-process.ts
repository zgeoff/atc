import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// What `/proc` shows of a process: its command-line arguments and its
// environment.
interface ProcProcess {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export function readProcProcess(procRoot: string, pid: number): ProcProcess | null {
  let cmdline: string;
  let environ: string;

  try {
    cmdline = readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8');
    environ = readFileSync(join(procRoot, String(pid), 'environ'), 'utf8');
  } catch {
    return null;
  }

  const env: Record<string, string> = {};

  for (const entry of environ.split('\0')) {
    const eq = entry.indexOf('=');

    if (eq > 0) {
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }

  return { args: cmdline.split('\0').filter((arg) => arg !== ''), env };
}
