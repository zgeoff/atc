import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubSignedOutGH } from './build-stub-signed-out-gh';
import { createStubBin } from './create-stub-bin';
import { openRepoStep } from './open-repo-step';
import { startTUIHarness } from './start-tui-harness';

// The client booted to its home screen with a signed-out `gh` on its PATH,
// so the GitHub repository step opens without reaching GitHub.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tui = stack.use(startTUIHarness());

  createStubBin(join(tui.home, 'bin'), 'gh', buildStubSignedOutGH());

  tui.boot();

  await tui.waitFor('atc — control tower');

  const owned = stack.move();

  return { tui, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it leaves a capture that starts at the tab to the GitHub repository step', async () => {
  await using ctx = await setupTest();

  await openRepoStep(ctx.tui);

  expect(ctx.tui.read()).not.toInclude('spawn: directory');
});
