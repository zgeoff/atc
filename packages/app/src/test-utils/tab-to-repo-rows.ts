import { KEYS } from '@atc/core/test-utils/keys';
import { openAgentStep } from './open-agent-step';
import type { TUIHarness } from './start-tui-harness';

export async function tabToRepoRows(tui: TUIHarness): Promise<void> {
  await openAgentStep(tui);

  tui.write(KEYS.enter);

  await tui.waitFor('spawn: workspace');

  tui.reset();
  tui.write(KEYS.tab);

  await tui.waitFor('\u001B[7mgithub:');
}
