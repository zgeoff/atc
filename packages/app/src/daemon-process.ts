import type { DaemonFlags } from './parse-daemon-flags';

// What a daemon was started with.
export interface DaemonProcess {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | null;
  readonly flags: DaemonFlags;

  // False when `/proc` could not be read, in which case `env` is this
  // process's own.
  readonly fromProc: boolean;
}
