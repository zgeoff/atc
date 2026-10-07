import { KEYS } from './keys';
import type { TUIHarness } from './start-tui-harness';

/**
 * Opens the GitHub repository step of a Claude spawn from the home screen:
 * the first agent, then a tab from the directory step to the next source.
 * Resolves once the step's title is drawn, with the capture holding what
 * the client drew since the tab.
 */
export async function openRepoStep(tui: Readonly<TUIHarness>): Promise<void> {
  tui.write('n');

  await tui.waitFor('spawn: agent');

  tui.write(KEYS.enter);

  await tui.waitFor('spawn: directory');

  tui.reset();
  tui.write(KEYS.tab);

  await tui.waitFor('spawn: GitHub repository');
}
