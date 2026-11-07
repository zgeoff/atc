import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import {
  KEYS,
  createGitFixture,
  getRecord,
  registerTestCleanup,
  startTUIHarness,
} from '@atc/test-utils';

function setupTest() {
  return startTUIHarness();
}

test('it shows why a forget kept the workspace until the next keypress', async () => {
  const ctx = setupTest();

  const fixture = await createGitFixture();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  const daemon = await openDaemonClient(ctx.paths.daemonSocketPath);

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const spawned = await daemon.sendRequest('session.spawn', {
    cwd: join(fixture.directory, 'orchard-main'),
    name: 'orchard',
    workspace: { kind: 'git', url: `file://${fixture.upstream}`, ref: 'main' },
    cols: 80,
    rows: 24,
  });

  const cwd = String(getRecord(spawned, 'session')['cwd']);

  writeFileSync(join(cwd, 'harvest-plan.md'), '# pick the pears first\n');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('orchard');
  await ctx.waitFor('┌ sessions ');

  ctx.write('K');

  await ctx.waitFor('kill selected session?');

  ctx.reset();
  ctx.write('y');

  await ctx.waitFor('killed');

  ctx.write('K');

  await ctx.waitFor('kill selected session?');

  ctx.reset();
  ctx.write('y');

  // the forget waits up to 2 seconds for the killed harness to exit, then ends it by force and
  // waits again, which on a loaded runner outlasts the default wait
  await ctx.waitFor('kept orchard-main: 1 uncommitted or untracked path', 10_000);

  ctx.reset();
  ctx.write('j');

  await ctx.waitFor('┘');

  expect(ctx.read()).not.toInclude('kept orchard-main');
});
