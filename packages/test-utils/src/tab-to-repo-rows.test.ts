import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubSignedOutGH } from './build-stub-signed-out-gh';
import { createStubBin } from './create-stub-bin';
import { startTUIHarness } from './start-tui-harness';
import { tabToRepoRows } from './tab-to-repo-rows';

// The client booted to its home screen with a signed-out `gh` on its PATH,
// so the GitHub rows settle without reaching GitHub.
async function setupTest() {
  const tui = startTUIHarness();

  createStubBin(join(tui.home, 'bin'), 'gh', buildStubSignedOutGH());

  tui.boot();

  await tui.waitFor('atc — control tower');

  return { tui };
}

test('it leaves a capture that starts at the tab to the GitHub rows of the list', async () => {
  const ctx = await setupTest();

  await tabToRepoRows(ctx.tui);

  expect(ctx.tui.read()).not.toInclude('spawn: agent');
});
