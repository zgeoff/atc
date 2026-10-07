import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubSignedOutGH } from './build-stub-signed-out-gh';
import { createStubBin } from './create-stub-bin';
import { openRepoStep } from './open-repo-step';
import { startTUIHarness } from './start-tui-harness';

test('it leaves a capture that starts at the tab to the GitHub repository step', async () => {
  await using tui = startTUIHarness();

  createStubBin(join(tui.home, 'bin'), 'gh', buildStubSignedOutGH());

  tui.boot();

  await tui.waitFor('atc — control tower');

  await openRepoStep(tui);

  expect(tui.read()).not.toInclude('spawn: directory');
});
