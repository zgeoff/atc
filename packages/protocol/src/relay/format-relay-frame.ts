import type { DaemonFrame } from './daemon-frame';
import type { GuestFrame } from './guest-frame';

export function formatRelayFrame(frame: DaemonFrame | GuestFrame): string {
  return `${JSON.stringify(frame)}\n`;
}
