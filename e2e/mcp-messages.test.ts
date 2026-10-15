import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupMCPHome } from '@atc/lifecycle/testing';
import { StateStore } from '@atc/store';
import { registerTestCleanup, startMCPStdio, waitFor } from '@atc/test-utils';

async function setupTest() {
  const mcpHome = setupMCPHome();

  const mcp = await startMCPStdio({ home: mcpHome.home });

  return { home: mcpHome.home, mcp };
}

test('it reports a message to a session with no tap as a failed tool call', async () => {
  const ctx = await setupTest();
  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  await waitFor(async () => {
    const listed = await ctx.mcp.sendToolCall('atc_sessions_list', {});

    expect(listed.text).toInclude('"agentSessionID": "fake-1"');
  });

  const result = await ctx.mcp.sendToolCall('atc_message_send', { session, text: 'hello' });

  expect(result).toStrictEqual({
    isError: true,
    text: expect.toStartWith('unsupported:'),
    structured: undefined,
  });
});

test('it sends a message to a session that has not started', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });
  const result = await ctx.mcp.sendToolCall('atc_message_send', { session, text: 'hello' });

  const message = result.structured?.['message'];

  expect(result).toStrictEqual({
    isError: undefined,
    text: `{\n  "message": "${String(message)}",\n  "status": "queued"\n}`,
    structured: { message: expect.stringMatching(/^m-[\da-f-]{36}$/u), status: 'queued' },
  });
});

test("it reads a message from the owner's atc mcp back as from the owner, whatever from the call gives", async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  const sent = await ctx.mcp.sendToolCall('atc_message_send', {
    session,
    text: 'hello',
    from: 'impostor',
  });

  const message = sent.structured?.['message'];

  const got = await ctx.mcp.sendToolCall('atc_message_get', { message });

  expect(JSON.parse(got.text)).toStrictEqual(got.structured);

  expect(got.structured).toStrictEqual({
    message,
    session,
    from: 'owner',
    sender: { kind: 'owner', name: 'owner' },
    text: 'hello',
    status: 'queued',
    sentAt: expect.toBeNumber(),
    turn: null,
    answeredWith: [],
  });
});

test('it reads a message from a session through its atc mcp back as from that session and its current name, whatever from the call gives', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const target = await ctx.mcp.spawnSession({ cwd: ctx.home });
  const sender = await ctx.mcp.spawnSession({ cwd: ctx.home });

  await ctx.mcp.sendToolCall('atc_session_update', { session: sender, name: 'harbor-refactor' });

  const inside = await startMCPStdio({ home: ctx.home, callerSessionID: sender });

  const sent = await inside.sendToolCall('atc_message_send', {
    session: target,
    text: 'hello',
    from: 'impostor',
  });

  const got = await ctx.mcp.sendToolCall('atc_message_get', {
    message: sent.structured?.['message'],
  });

  expect(got.structured).toMatchObject({
    from: 'harbor-refactor',
    sender: { kind: 'session', session: sender, name: 'harbor-refactor' },
  });
});

test('it replays a message key an older atc mcp stored with a given from, and labels each message by its caller', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  const text = 'check the tide tables';

  const first = await ctx.mcp.sendToolCall('atc_message_send', {
    session,
    text,
    idempotencyKey: 'k-first',
  });

  const message = String(first.structured?.['message']);

  // An older atc mcp sent the same message with from release-bot, and its
  // daemon stored the SHA-256 of those params, keys sorted, without the key.
  const seed = await StateStore.open(join(ctx.home, '.local', 'state', 'atc', 'atc.db'));

  const stopSeed = registerTestCleanup(() => seed.stop());
  const id = { principal: 'local', operation: 'session.message', key: 'k-tide' };

  await seed.claimIdempotencyKey({
    ...id,
    payloadHash: createHash('sha256')
      .update(JSON.stringify({ from: 'release-bot', session, text }))
      .digest('hex'),
    effectRef: message,
    at: Date.now(),
  });

  await seed.updateIdempotencyCompleted(
    id,
    JSON.stringify({ message, status: 'queued' }),
    Date.now(),
    null,
  );

  await stopSeed();

  const retry = { session, text, from: 'release-bot', idempotencyKey: 'k-tide' };

  const replayed = await ctx.mcp.sendToolCall('atc_message_send', retry);

  const fresh = await ctx.mcp.sendToolCall('atc_message_send', {
    ...retry,
    idempotencyKey: 'k-fresh',
  });

  const senders = await Promise.all(
    [message, fresh.structured?.['message']].map(async (sent) => {
      const got = await ctx.mcp.sendToolCall('atc_message_get', { message: sent });

      return [got.structured?.['from'], got.structured?.['sender']];
    }),
  );

  expect(replayed.structured).toStrictEqual({ message, status: 'queued' });
  expect(fresh.structured?.['message']).not.toBe(message);

  expect(senders).toStrictEqual([
    ['owner', { kind: 'owner', name: 'owner' }],
    ['owner', { kind: 'owner', name: 'owner' }],
  ]);
});

test('it holds a message read open while its wait runs', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  const sent = await ctx.mcp.sendToolCall('atc_message_send', {
    session,
    text: 'hello',
    from: 'tester',
  });

  const message = sent.structured?.['message'];
  const held = ctx.mcp.sendToolCall('atc_message_get', { message, waitMs: 30_000 });

  // The read fails when cleanup stops the server; settling it here keeps
  // that failure from going unhandled.
  void Promise.allSettled([held]);

  // The second read goes out after the held one and takes the same path, so
  // its answer shows the held read has reached the daemon's wait.
  await ctx.mcp.sendToolCall('atc_message_get', { message });

  expect(Bun.peek.status(held)).toBe('pending');
});

test('it answers a message read with the unanswered message once its wait ends', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const session = await ctx.mcp.spawnSession({ cwd: ctx.home });

  const sent = await ctx.mcp.sendToolCall('atc_message_send', {
    session,
    text: 'hello',
    from: 'tester',
  });

  const message = sent.structured?.['message'];

  const got = await ctx.mcp.sendToolCall('atc_message_get', { message, waitMs: 1 });

  expect(got.structured).toStrictEqual({
    message,
    session,
    from: 'owner',
    sender: { kind: 'owner', name: 'owner' },
    text: 'hello',
    status: 'queued',
    sentAt: expect.toBeNumber(),
    turn: null,
    answeredWith: [],
  });
});
