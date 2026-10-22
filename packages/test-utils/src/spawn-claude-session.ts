import { KEYS } from './keys';
import type { TUIHarness } from './start-tui-harness';

export async function spawnClaudeSession(tui: TUIHarness, name: string): Promise<void> {
  tui.reset();
  tui.write('n');

  // The agent step drops each key it takes while it reads the agents, and
  // draws the selected row only once it has read them.
  await tui.waitFor('\u001B[7mClaude');

  tui.write(KEYS.enter);

  await tui.waitFor('spawn: directory');

  tui.write(KEYS.enter);

  await tui.waitFor('spawn: name');

  tui.reset();
  tui.write(`${name}${KEYS.enter}`);

  await tui.waitFor('spawn: initial prompt');

  tui.reset();
  tui.write(KEYS.enter);

  await tui.waitFor('FAKE_CLAUDE_UP');
}
