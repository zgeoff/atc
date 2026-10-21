import type { TUIHarness } from './start-tui-harness';

// Opens the spawn picker and waits until it has read the agents, since the
// agent step drops each key it takes while it reads them. The wait is for the
// selected row, which the step draws only once the agents are read.
export async function openAgentStep(tui: TUIHarness, selected = 'Claude'): Promise<void> {
  tui.reset();
  tui.write('n');

  await tui.waitFor(`\u001B[7m${selected}`);
}
