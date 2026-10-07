import { KEYS } from './keys';
import type { TUIHarness } from './start-tui-harness';

/**
 * Spawns a Claude session named `name` through the client's spawn flow,
 * from the home screen or the overlay: the first agent, the first
 * directory, the name, and no first prompt. Resolves once the fake
 * `claude` paints, with the capture holding what the client drew since the
 * prompt step.
 */
// oxlint-disable-next-line prefer-readonly-parameter-types -- a harness is a live handle
export async function spawnClaudeSession(tui: TUIHarness, name: string): Promise<void> {
  tui.write('n');

  await tui.waitFor('spawn: agent');

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
