import { join } from 'node:path';
import { createDaemonClient } from '@atc/protocol/client';
import { spawnNamedSession } from '@atc/protocol/test-utils/spawn-named-session';
import type { TUIHarness } from './start-tui-harness';

export async function spawnDaemonSession(tui: TUIHarness, name: string): Promise<string> {
  const daemon = createDaemonClient(join(tui.home, 'atc-daemon.sock'));

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
