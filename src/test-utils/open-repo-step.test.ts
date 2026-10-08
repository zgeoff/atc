import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubSignedOutGH } from './build-stub-signed-out-gh';
import { createStubBin } from './create-stub-bin';
import { openRepoStep } from './open-repo-step';
import { startTUIHarness } from './start-tui-harness';

// The client booted to its home screen with a signed-out `gh` on its PATH,
// so the GitHub repository step opens without reaching GitHub.
async function setupTest() {
  const tui = startTUIHarness();

  createStubBin(join(tui.home, 'bin'), 'gh', buildStubSignedOutGH());

  tui.boot();

  await tui.waitFor('atc — control tower');

  return { tui };
}

test('it leaves a capture that starts at the tab to the GitHub repository step', async () => {
  const ctx = await setupTest();

  await openRepoStep(ctx.tui);

  expect(ctx.tui.read()).not.toInclude('spawn: directory');
});
