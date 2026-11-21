import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubSignedOutGH } from '@atc/source-github/test-utils/build-stub-signed-out-gh';
import { createStubBin } from '@zgeoff/testing/bin';
import { startTUIHarness } from './start-tui-harness';
import { tabToRepoRows } from './tab-to-repo-rows';

// A signed-out `gh` on the PATH lets the GitHub rows settle without any call to GitHub.
async function setupTest() {
  const tui = startTUIHarness({ createStateDB: () => {} });

  createStubBin(join(tui.home, 'bin'), 'gh', { script: buildStubSignedOutGH() });

  tui.boot();

  await tui.waitFor('atc — control tower');

  return { tui };
}

test('it leaves a capture that starts at the tab to the GitHub rows of the list', async () => {
  const ctx = await setupTest();

  await tabToRepoRows(ctx.tui);

  expect(ctx.tui.read()).not.toInclude('spawn: agent');
});
