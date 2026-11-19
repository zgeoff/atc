import type { DaemonFrame } from './daemon-frame';
import type { GuestFrame } from './guest-frame';

// One frame as the line it travels in, newline included.
export function formatRelayFrame(frame: DaemonFrame | GuestFrame): string {
  return `${JSON.stringify(frame)}\n`;
}
