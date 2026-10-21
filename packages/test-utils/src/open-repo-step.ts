import { KEYS } from './keys';
import { openAgentStep } from './open-agent-step';
import type { TUIHarness } from './start-tui-harness';

export async function openRepoStep(tui: TUIHarness): Promise<void> {
  await openAgentStep(tui);

  tui.write(KEYS.enter);

  await tui.waitFor('spawn: directory');

  tui.reset();
  tui.write(KEYS.tab);

  await tui.waitFor('spawn: GitHub repository');
}
