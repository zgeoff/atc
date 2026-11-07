import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { createMigratedStateDB } from '@atc/store/test-utils';
import {
  KEYS,
  createGitFixture,
  getRecord,
  registerTestCleanup,
  startTUIHarness,
} from '@atc/test-utils';

// The client boots its own daemon, so the test's client connects once the tower draws.
async function setupTest() {
  const tui = startTUIHarness({ createStateDB: createMigratedStateDB });

  tui.boot();

  await tui.waitFor('atc — control tower');

  const daemon = await openDaemonClient(tui.paths.daemonSocketPath);

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  return { tui, daemon };
}

test('it shows why a forget kept the workspace until the next keypress', async () => {
  const ctx = await setupTest();
  const fixture = await createGitFixture();

  const spawned = await ctx.daemon.sendRequest('session.spawn', {
    cwd: join(fixture.directory, 'orchard-main'),
    name: 'orchard',
    workspace: { kind: 'git', url: `file://${fixture.upstream}`, ref: 'main' },
    cols: 80,
    rows: 24,
  });

  const cwd = String(getRecord(spawned, 'session')['cwd']);

  writeFileSync(join(cwd, 'harvest-plan.md'), '# pick the pears first\n');

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('orchard');
  await ctx.tui.waitFor('┌ sessions ');

  ctx.tui.write('K');

  await ctx.tui.waitFor('kill selected session?');

  ctx.tui.reset();
  ctx.tui.write('y');

  await ctx.tui.waitFor('killed');

  ctx.tui.reset();
  ctx.tui.write('K');

  await ctx.tui.waitFor('kill selected session?');

  ctx.tui.reset();
  ctx.tui.write('y');

  await ctx.tui.waitFor('kept orchard-main: 1 uncommitted or untracked path');

  ctx.tui.reset();
  ctx.tui.write('j');

  await ctx.tui.waitFor('┘');

  expect(ctx.tui.read()).not.toInclude('kept orchard-main');
});
