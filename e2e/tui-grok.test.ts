import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYS } from '../src/test-utils/keys';
import { registerTestCleanup } from '../src/test-utils/register-test-cleanup';
import { spawnGrokSession } from '../src/test-utils/spawn-grok-session';
import { startTUIHarness } from '../src/test-utils/start-tui-harness';
import { waitFor } from '../src/test-utils/wait-for';

function setupTest() {
  return startTUIHarness();
}

test('it spawns a grok session without resume or -p and marks it resumable', async () => {
  const ctx = setupTest();

  // The agent reports its session only once the test removes this file,
  // while its fleet row already exists without the id.
  writeFileSync(join(ctx.home, 'fake-grok-defer-start'), '');

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, 'groksess');

  const captured = ctx.read();

  // The TUI paints with cursor moves and no newlines, so the args reach the
  // capture on the same line as a whole screen of session names.
  expect(captured).toMatch(/FAKE_GROK_UP args: --no-leader/u);
  expect(captured).not.toMatch(/FAKE_GROK_UP args:[^\r\n]*(?:--resume|-p)/u);
  expect(captured).not.toInclude('FAKE_CLAUDE_UP');

  rmSync(join(ctx.home, 'fake-grok-defer-start'));

  const db = new Database(join(ctx.home, '.local', 'state', 'atc', 'atc.db'), { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  // The row lands at spawn, before the agent reports its session id, so
  // the wait runs until the row holds that id.
  await waitFor(() => {
    expect(
      db.query('SELECT name, cwd, agent_session_id AS agentSessionID, agent FROM fleet').all(),
    ).toStrictEqual([
      { name: 'groksess', cwd: ctx.home, agentSessionID: 'fake-grok-1', agent: 'grok' },
    ]);
  });

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('groksess');
  await ctx.waitFor('Grok');
}, 15_000);

test('it marks a grok session done on end-turn Stop', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({ hookEventName: 'stop', sessionId: 'fake-grok-1', reason: 'end_turn' })}\n`,
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, 'grokdone');

  await ctx.waitFor('FAKE_GROK_HOOKS_DONE');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('✓ 1 done');
}, 15_000);

test('it marks a grok session done on StopCancelled', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({
      hookEventName: 'stop_cancelled',
      sessionId: 'fake-grok-1',
      reason: 'user_interrupt',
    })}\n`,
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, 'grokcancel');

  await ctx.waitFor('FAKE_GROK_HOOKS_DONE');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('✓ 1 done');
}, 15_000);

test('it keeps a grok session running when a hook names a subagent', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({
      hookEventName: 'stop',
      sessionId: 'fake-grok-1',
      reason: 'end_turn',
      subagentType: 'explore',
    })}\n`,
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, 'groksub');

  await ctx.waitFor('FAKE_GROK_HOOKS_DONE');

  const db = new Database(join(ctx.home, '.local', 'state', 'atc', 'atc.db'), { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  // The daemon writes each hook it takes to the trail with the kind it read
  // the hook as, after it has applied the hook to the session.
  await waitFor(() => {
    expect(db.query("SELECT kind FROM events WHERE event = 'Stop'").all()).toStrictEqual([
      { kind: 'heartbeat' },
    ]);
  });

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('┌ sessions ');
  await ctx.waitFor('running');

  expect(ctx.read()).not.toInclude('need you');
  expect(ctx.read()).not.toInclude('done');
}, 15_000);

test('it yanks a grok resume command once the id is captured', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, 'grokyank');

  await ctx.waitFor('FAKE_GROK_HOOKS_DONE');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: grokyank');
  await ctx.waitFor('┌ sessions ');

  ctx.reset();
  ctx.write('y');

  await ctx.waitFor('resume cmd copied');

  expect(ctx.read()).toInclude(
    `]52;c;${Buffer.from(`cd '${ctx.home}' && grok --resume fake-grok-1`).toString('base64')}${KEYS.bel}`,
  );
}, 15_000);

test('it yanks a grok command without --resume before SessionStart', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.home, 'fake-grok-hold-start'), '');

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, 'grokearly');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('grokearly');
  await ctx.waitFor('┌ sessions ');

  ctx.reset();
  ctx.write('y');

  await ctx.waitFor('resume cmd copied');

  expect(ctx.read()).toInclude(
    `]52;c;${Buffer.from(`cd '${ctx.home}' && grok`).toString('base64')}${KEYS.bel}`,
  );
}, 15_000);

test('it ignores H on a grok row instead of opening the eject picker', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, 'grokheadless');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('grokheadless');
  await ctx.waitFor('┌ sessions ');

  ctx.reset();

  const mark = ctx.markClientLog();

  ctx.write('H');

  await ctx.waitForClientLog('ignored H on a session that cannot eject', mark);

  expect(ctx.read()).not.toInclude('eject: headless instruction');

  ctx.write('?');

  await ctx.waitFor('┌ keys ');

  expect(ctx.read()).not.toInclude('eject: headless instruction');
}, 15_000);

test('it keeps needs-you when grok emits idle_prompt after permission_prompt', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({
      hookEventName: 'notification',
      sessionId: 'fake-grok-1',
      notificationType: 'permission_prompt',
      message: 'allow edit?',
    })}\n${JSON.stringify({
      hookEventName: 'notification',
      sessionId: 'fake-grok-1',
      notificationType: 'idle_prompt',
    })}\n`,
  );

  ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, 'grokidle');

  await ctx.waitFor('FAKE_GROK_HOOKS_DONE');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('need you: grokidle');
  await ctx.waitFor('┌ sessions ');
}, 15_000);
