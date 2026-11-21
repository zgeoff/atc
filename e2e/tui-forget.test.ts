import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { createGitFixture } from '@atc/core/test-utils/create-git-fixture';
import { getRecord } from '@atc/core/test-utils/get-record';
import { KEYS } from '@atc/core/test-utils/keys';
import { createDaemonClient } from '@atc/protocol/client';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';

// The client boots its own daemon, so the test's client can only connect once the tower draws.
async function setupTest() {
  const tui = startTUIHarness({ createStateDB: createMigratedStateDB });

  tui.boot();

  await tui.waitFor('atc — control tower');

  const daemon = createDaemonClient(tui.paths.daemonSocketPath);

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  return { tui, daemon };
}

test('it shows the kept folder on home after X ends the attached session, and never on a later open', async () => {
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

  await ctx.tui.waitFor('╭─ ');

  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('FAKE_CLAUDE_UP args:');
  await ctx.tui.waitForGone('╭─ ');

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('╭─ ');

  ctx.tui.write('X');

  await ctx.tui.waitFor('end orchard?');

  ctx.tui.reset();
  ctx.tui.write('y');

  await ctx.tui.waitForGone('╭─ ');
  await ctx.tui.waitFor('atc — control tower');
  await ctx.tui.waitFor('kept orchard-main');

  ctx.tui.reset();
  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('╭─ ');

  ctx.tui.write(KEYS.esc);

  await ctx.tui.waitForGone('╭─ ');

  // The open cleared the screen, so the status bar home shows now is one drawn after it.
  await waitFor(() => {
    expect(ctx.tui.readScreen()).toInclude('atc ▏');
  });

  expect(ctx.tui.readScreen()).not.toInclude('kept orchard-main');
});

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
  await ctx.tui.waitFor('╭─ ');

  ctx.tui.write('K');

  await ctx.tui.waitFor('kill orchard? · y / n');

  ctx.tui.reset();
  ctx.tui.write('y');

  await ctx.tui.waitFor('killed');

  ctx.tui.reset();
  ctx.tui.write('X');

  await ctx.tui.waitFor('end orchard? stops the agent and removes it from the list · y / n');

  ctx.tui.reset();
  ctx.tui.write('y');

  await ctx.tui.waitFor('kept orchard-main: 1 uncommitted or untracked path');

  ctx.tui.reset();
  ctx.tui.write('j');

  await ctx.tui.waitFor('n new');

  expect(ctx.tui.read()).not.toInclude('kept orchard-main');
});
