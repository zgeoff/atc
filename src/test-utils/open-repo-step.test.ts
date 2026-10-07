import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import { openRepoStep } from './open-repo-step';
import { startTUIHarness } from './start-tui-harness';

test('it leaves the client on the GitHub repository step', async () => {
  await using tui = startTUIHarness();

  createStubBin(join(tui.home, 'bin'), 'gh', "#!/bin/sh\necho 'gh auth login' >&2\nexit 4\n");

  tui.boot();

  await tui.waitFor('atc — control tower');

  await openRepoStep(tui);

  expect(tui.read()).toInclude('spawn: GitHub repository');
});
