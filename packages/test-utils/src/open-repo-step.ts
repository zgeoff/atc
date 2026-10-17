import { KEYS } from './keys';
import type { TUIHarness } from './start-tui-harness';

export async function openRepoStep(tui: TUIHarness): Promise<void> {
  tui.write('n');

  await tui.waitFor('spawn: agent');

  tui.write(KEYS.enter);

  await tui.waitFor('spawn: directory');

  tui.reset();
  tui.write(KEYS.tab);

  await tui.waitFor('spawn: GitHub repository');
}
