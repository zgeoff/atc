import { expect, test } from 'bun:test';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';

async function setupTest() {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-permission-pending-',
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({ agents: { claude: { bin: 'bash', args: ['-c', 'sleep 30'] } } }),
      ),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'claude',
    cols: 80,
    rows: 24,
  });

  const sessionID = getRecord(spawned, 'session')['id'];

  const sendNotification = async (type: string, message: string) => {
    await daemon.sendHookLines({
      atcId: sessionID,
      agent: 'claude',
      event: 'Notification',
      payload: { message, notification_type: type },
    });

    await waitFor(async () => {
      const listed = await daemon.client.sendRequest('session.list');

      expect(JSON.stringify(listed)).toInclude(message);
    });
  };

  return { daemon, sessionID, sendNotification };
}

test('it refuses a submitted line while a permission prompt is pending', async () => {
  const ctx = await setupTest();

  await ctx.sendNotification('permission_prompt', 'Claude needs your permission to use Bash');

  expect(
    ctx.daemon.client.sendRequest('session.submit', { session: ctx.sessionID, text: 'no' }),
  ).rejects.toMatchObject({ code: 'permission_pending' });
});

test('it takes a submitted line again once the session moves on', async () => {
  const ctx = await setupTest();

  await ctx.sendNotification('permission_prompt', 'Claude needs your permission to use Bash');

  await ctx.daemon.sendHookLines({
    atcId: ctx.sessionID,
    agent: 'claude',
    event: 'UserPromptSubmit',
    payload: { prompt: 'carry on' },
  });

  await waitFor(async () => {
    const submitted = await ctx.daemon.client.sendRequest('session.submit', {
      session: ctx.sessionID,
      text: 'go',
    });

    expect(submitted).toStrictEqual({});
  });
});

test('it takes a submitted line while an idle notification is pending', async () => {
  const ctx = await setupTest();

  await ctx.sendNotification('idle_prompt', 'Claude is waiting for your input');

  const submitted = await ctx.daemon.client.sendRequest('session.submit', {
    session: ctx.sessionID,
    text: 'go',
  });

  expect(submitted).toStrictEqual({});
});

test('it takes raw input while a permission prompt is pending', async () => {
  const ctx = await setupTest();

  await ctx.sendNotification('permission_prompt', 'Claude needs your permission to use Bash');

  const input = await ctx.daemon.client.sendRequest('session.input', {
    session: ctx.sessionID,
    d: '2',
  });

  expect(input).toStrictEqual({});
});

test('it keeps refusing a submitted line after a statusline report', async () => {
  const ctx = await setupTest();

  await ctx.sendNotification('permission_prompt', 'Claude needs your permission to use Bash');

  await ctx.daemon.sendHookLines({
    atcId: ctx.sessionID,
    agent: 'claude',
    event: 'Statusline',
    payload: { session_id: 'agent-session-1' },
  });

  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(JSON.stringify(listed)).toInclude('agent-session-1');
  });

  expect(
    ctx.daemon.client.sendRequest('session.submit', { session: ctx.sessionID, text: 'no' }),
  ).rejects.toMatchObject({ code: 'permission_pending' });
});

test('it keeps refusing a submitted line after a notification of another type', async () => {
  const ctx = await setupTest();

  await ctx.sendNotification('permission_prompt', 'Claude needs your permission to use Bash');
  await ctx.sendNotification('agent_completed', 'A background agent finished');

  expect(
    ctx.daemon.client.sendRequest('session.submit', { session: ctx.sessionID, text: 'no' }),
  ).rejects.toMatchObject({ code: 'permission_pending' });
});

test('it keeps refusing a submitted line after a client attaches', async () => {
  const ctx = await setupTest();

  await ctx.sendNotification('permission_prompt', 'Claude needs your permission to use Bash');

  await ctx.daemon.client.sendRequest('session.attach', {
    session: ctx.sessionID,
    cols: 80,
    rows: 24,
  });

  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(JSON.stringify(listed)).not.toInclude('needs_you');
  });

  expect(
    ctx.daemon.client.sendRequest('session.submit', { session: ctx.sessionID, text: 'no' }),
  ).rejects.toMatchObject({ code: 'permission_pending' });
});

test('it takes a submitted line again after an idle notice', async () => {
  const ctx = await setupTest();

  await ctx.sendNotification('permission_prompt', 'Claude needs your permission to use Bash');
  await ctx.sendNotification('idle_prompt', 'Claude is waiting for your input');

  const submitted = await ctx.daemon.client.sendRequest('session.submit', {
    session: ctx.sessionID,
    text: 'go',
  });

  expect(submitted).toStrictEqual({});
});
