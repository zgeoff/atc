import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { spawnNamedSession } from './spawn-named-session';
import type { TUIHarness } from './start-tui-harness';

// Spawns a session in the client's home over the socket of the daemon the
// client started, for a test whose subject comes after the spawn picker.
export async function spawnDaemonSession(tui: TUIHarness, name: string): Promise<string> {
  const daemon = await openDaemonClient(join(tui.home, 'atc-daemon.sock'));

  try {
    await daemon.sendHello('atc/test');

    return await spawnNamedSession(
      (method, params) => daemon.sendRequest(method, params),
      name,
      tui.home,
    );
  } finally {
    daemon.stop();
  }
}
