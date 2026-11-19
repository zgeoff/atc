import type { DaemonFlags } from '../boot/parse-daemon-flags';

export interface DaemonProcess {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | null;
  readonly flags: DaemonFlags;

  readonly fromProc: boolean;
}
