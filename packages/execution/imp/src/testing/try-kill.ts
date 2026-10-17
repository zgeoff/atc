import type { IPty } from 'bun-pty';

export function tryKill(pty: IPty, signal: NodeJS.Signals): void {
  try {
    process.kill(pty.pid, signal);
  } catch {}
}
