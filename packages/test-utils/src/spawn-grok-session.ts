import { KEYS } from './keys';
import type { TUIHarness } from './start-tui-harness';

export async function spawnGrokSession(tui: TUIHarness, name: string): Promise<void> {
  tui.write('n');

  await tui.waitFor('spawn: agent');

  tui.reset();
  tui.write(KEYS.down);

  await tui.waitFor('\u001B[7mGrok');

  tui.write(KEYS.enter);

  await tui.waitFor('spawn: directory');

  tui.write(KEYS.enter);

  await tui.waitFor('spawn: name');

  tui.reset();
  tui.write(`${name}${KEYS.enter}`);

  await tui.waitFor('spawn: initial prompt');

  tui.reset();
  tui.write(KEYS.enter);

  await tui.waitFor('FAKE_GROK_UP');
}
