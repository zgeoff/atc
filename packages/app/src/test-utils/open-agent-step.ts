import type { TUIHarness } from './start-tui-harness';

// The agent step drops every key it gets while it reads the agents. It draws the
// selected row in inverse video only after the read, so wait for that row before typing.
export async function openAgentStep(tui: TUIHarness): Promise<void> {
  tui.reset();
  tui.write('n');

  await tui.waitFor('\u001B[7mClaude');
}
