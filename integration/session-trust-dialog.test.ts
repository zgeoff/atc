import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { getRecord, getRecords, getString, waitFor } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { startStubAgentDaemon } from '../packages/app/src/test-utils/start-stub-agent-daemon';

// Claude Code runs no hook while its folder-trust dialog waits, so the
// stand-in holds its start and the test draws the dialog on its terminal.
function setupTest() {
  return startStubAgentDaemon();
}

test('it shows a Claude session at the folder-trust dialog as needs_you with a pending text', async () => {
  const ctx = await setupTest();

  ctx.agents.holdStart('claude');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  const stub = await waitFor(() => {
    const [session] = ctx.agents.sessions;

    invariant(session);

    return session;
  });

  stub.harness.emitData(
    [
      ' Accessing workspace:',
      '',
      ' /srv/orchard/checkout',
      '',
      ' Quick safety check: Is this a project you created or one you trust?',
      '',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      '',
      ' Enter to confirm · Esc to cancel',
    ].join('\r\n'),
  );

  const read = await waitFor(async () => {
    const answer = await ctx.daemon.client.sendRequest('session.get', { session: id });

    expect(getRecord(answer, 'session')['state']).toBe('needs_you');

    return answer;
  });

  expect(read).toMatchObject({ pending: { message: 'waiting at a prompt' } });
});

test('it records one needs-input event for the folder-trust dialog and runs on once Claude starts', async () => {
  const ctx = await setupTest();

  ctx.agents.holdStart('claude');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  const stub = await waitFor(() => {
    const [session] = ctx.agents.sessions;

    invariant(session);

    return session;
  });

  stub.harness.emitData(
    [
      ' Quick safety check: Is this a project you created or one you trust?',
      '',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
    ].join('\r\n'),
  );

  await waitFor(async () => {
    const answer = await ctx.daemon.client.sendRequest('session.get', { session: id });

    expect(getRecord(answer, 'session')['state']).toBe('needs_you');
  });

  stub.harness.emitData('\u001B[2J\u001B[H ✻ Welcome to Claude Code!\r\n');

  await stub.report({
    hook_event_name: 'SessionStart',
    session_id: 'fake-1',
    transcript_path: join(ctx.home, 'fake-transcript.jsonl'),
  });

  const read = await waitFor(async () => {
    const answer = await ctx.daemon.client.sendRequest('session.get', { session: id });

    expect(getRecord(answer, 'session')['state']).toBe('running');

    return answer;
  });

  const trail = await ctx.daemon.client.sendRequest('events.read', {});

  expect(read).toMatchObject({ pending: null });

  expect(getRecords(trail, 'events').map((event) => event['kind'])).toStrictEqual([
    'needs-input',
    'started',
  ]);
});
