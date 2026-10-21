import { KEYS } from './keys';
import { openAgentStep } from './open-agent-step';
import type { TUIHarness } from './start-tui-harness';

export async function spawnGrokSession(tui: TUIHarness, name: string): Promise<void> {
  await openAgentStep(tui);

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
