import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { REQUEST_ACCESS_CLASSES } from './request-access-classes';

/**
 * A real daemon that admits the principal `gw` to the `local` target, over
 * its socket and over a TCP listener whose gateway token is 32 `a`s. The
 * agent takes messages, so the message methods reach their own checks.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const daemon = await startTestDaemon({
    options: (paths) => {
      const tokenFile = join(paths.dir, 'gateway-token');

      writeFileSync(tokenFile, `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter({
          takesMessages: true,
          normalizeHook: () => ({ kind: 'prompt-submitted' }),
          buildResumeCommand: () => 'claude --resume',
        }),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile },
      };
    },
  });

  stack.use(daemon);

  const owned = stack.move();

  return { daemon, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it keeps the daemon-wide and credential methods, and only those, owner-only', () => {
  const owned = Object.entries(REQUEST_ACCESS_CLASSES)
    .filter(([, access]) => access === 'owner')
    .map(([method]) => method);

  expect(owned).toIncludeSameMembers([
    'daemon.quit',
    'fleet.restore',
    'session.auth.revoke',
    'session.auth.rebind',
  ]);
});

test('it opens every other method to a principal', () => {
  const open = Object.entries(REQUEST_ACCESS_CLASSES)
    .filter(([, access]) => access === 'principal')
    .map(([method]) => method);

  expect(open).toIncludeSameMembers([
    'daemon.hello',
    'daemon.ping',
    'session.list',
    'dirs.list',
    'agents.list',
    'fleet.list',
    'session.detach',
    'events.read',
    'sources.list',
    'sources.interpret',
    'git.probe',
    'session.spawn',
    'session.kill',
    'session.ack',
    'session.forget',
    'session.resumeCommand',
    'session.update',
    'session.attach',
    'session.input',
    'session.submit',
    'session.resize',
    'session.screen',
    'session.eject',
    'session.adopt',
    'permission.respond',
    'session.get',
    'session.read',
    'session.message',
    'session.tap',
    'message.get',
    'report.get',
    'message.ack',
  ]);
});

test.each(
  Object.entries(REQUEST_ACCESS_CLASSES)
    .filter(([, access]) => access === 'owner')
    .map(([method]) => [method]),
)('it refuses %s from a principal connection as owner-only', async (method) => {
  await using ctx = await setupTest();

  const client = await ctx.daemon.openClient({ principal: 'gw' });

  expect(client.sendRequest(method, {})).rejects.toMatchObject({
    code: 'unauthorized',
    message: `${method} is open to the daemon's owner only`,
  });
});

test.each(
  Object.entries(REQUEST_ACCESS_CLASSES)
    .filter(([, access]) => access === 'owner')
    .map(([method]) => [method]),
)('it refuses %s from the owner acting as a principal as owner-only', async (method) => {
  await using ctx = await setupTest();

  expect(ctx.daemon.client.sendRequest(method, {}, 'gw')).rejects.toMatchObject({
    code: 'unauthorized',
    message: `${method} is open to the daemon's owner only`,
  });
});

test.each(
  Object.entries(REQUEST_ACCESS_CLASSES)
    .filter(([, access]) => access === 'owner')
    .map(([method]) => [method]),
)('it refuses %s over TCP as owner-only', async (method) => {
  await using ctx = await setupTest();

  const client = await ctx.daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  expect(client.sendRequest(method, {}, 'gw')).rejects.toMatchObject({
    code: 'unauthorized',
    message: `${method} is open to the daemon's owner only`,
  });
});

test('it keeps answering the owner after it refuses an owner-only method to a principal', async () => {
  await using ctx = await setupTest();

  const client = await ctx.daemon.openClient({ principal: 'gw' });

  await client.sendRequest('fleet.restore', {}).catch(() => null);

  const pinged = await ctx.daemon.client.sendRequest('daemon.ping', {});

  expect(pinged).toStrictEqual({});
});

// The owner's quit stops the daemon under the test, so the daemon e2e suite
// covers it instead.
test('it admits fleet.restore from the owner', async () => {
  await using ctx = await setupTest();

  expect(ctx.daemon.client.sendRequest('fleet.restore', {})).resolves.toStrictEqual({
    restored: 0,
  });
});

test.each([
  ['session.auth.revoke', 'no_such_session'],
  ['session.auth.rebind', 'no_such_session'],
])('it admits %s from the owner, which answers it with %s', async (method, code) => {
  await using ctx = await setupTest();

  expect(ctx.daemon.client.sendRequest(method, {})).rejects.toMatchObject({ code });
});

// The handshake has rules of its own and is answered before admission, so
// the rows leave it out.
test.each([
  ['daemon.ping', {}],
  ['session.list', { sessions: [] }],
  ['dirs.list', { dirs: [] }],
  [
    'agents.list',
    {
      daemon: {
        hostname: expect.toBeString(),
        platform: process.platform,
        arch: process.arch,
        build: 'atc/test-build',
      },
      agents: [
        {
          id: 'claude',
          label: 'claude',
          kind: 'claude',
          installed: false,
          brokerAuth: false,
          brokerRequired: false,
          capabilities: {
            spawn: false,
            readTranscript: false,
            message: true,
            attach: true,
            screen: true,
            input: true,
          },
          models: null,
          spawnOptions: {
            model: {
              supported: false,
              available: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            effort: {
              supported: false,
              available: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
          },
        },
      ],
      targets: [
        {
          id: 'local',
          provider: 'local-pty',
          identity: expect.toStartWith('local-pty:'),
          available: true,
          default: true,
          capabilities: {
            spawn: true,
            attach: true,
            input: true,
            resize: true,
            kill: true,
            transfer: true,
            run: true,
            headless: true,
            suspend: false,
            destroy: false,
          },
          brokerAuth: false,
        },
      ],
      spawnDefaults: { agent: 'claude', target: 'local' },
      configRevision: expect.toBeString(),
      targetErrors: [],
      sources: [],
    },
  ],
  ['fleet.list', { fleet: [] }],
  ['session.detach', {}],
  ['events.read', { events: [], cursor: expect.toBeString(), more: false }],
] as const)('it admits %s from a principal connection', async (method, reply) => {
  await using ctx = await setupTest();

  const client = await ctx.daemon.openClient({ principal: 'gw' });

  expect(client.sendRequest(method, {})).resolves.toStrictEqual(reply);
});

test.each([
  ['sources.list', 'bad_args'],
  ['sources.interpret', 'bad_args'],
  ['git.probe', 'bad_args'],
  ['session.spawn', 'bad_args'],
  ['session.kill', 'no_such_session'],
  ['session.ack', 'no_such_session'],
  ['session.forget', 'no_such_session'],
  ['session.resumeCommand', 'no_such_session'],
  ['session.update', 'no_such_session'],
  ['session.attach', 'no_such_session'],
  ['session.input', 'no_such_session'],
  ['session.submit', 'no_such_session'],
  ['session.resize', 'bad_args'],
  ['session.screen', 'no_such_session'],
  ['session.eject', 'no_such_session'],
  ['session.adopt', 'no_such_session'],
  ['permission.respond', 'bad_args'],
  ['session.get', 'no_such_session'],
  ['session.read', 'no_such_session'],
  ['session.message', 'bad_args'],
  ['session.tap', 'no_such_session'],
  ['message.get', 'bad_args'],
  ['report.get', 'bad_args'],
  ['message.ack', 'bad_args'],
])('it admits %s from a principal connection, which answers it with %s', async (method, code) => {
  await using ctx = await setupTest();

  const client = await ctx.daemon.openClient({ principal: 'gw' });

  expect(client.sendRequest(method, {})).rejects.toMatchObject({ code });
});

test.each([
  ['daemon.ping', {}],
  ['session.list', { sessions: [] }],
  ['dirs.list', { dirs: [] }],
  [
    'agents.list',
    {
      daemon: {
        hostname: expect.toBeString(),
        platform: process.platform,
        arch: process.arch,
        build: 'atc/test-build',
      },
      agents: [
        {
          id: 'claude',
          label: 'claude',
          kind: 'claude',
          installed: false,
          brokerAuth: false,
          brokerRequired: false,
          capabilities: {
            spawn: false,
            readTranscript: false,
            message: true,
            attach: true,
            screen: true,
            input: true,
          },
          models: null,
          spawnOptions: {
            model: {
              supported: false,
              available: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            effort: {
              supported: false,
              available: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
          },
        },
      ],
      targets: [
        {
          id: 'local',
          provider: 'local-pty',
          identity: expect.toStartWith('local-pty:'),
          available: true,
          default: true,
          capabilities: {
            spawn: true,
            attach: true,
            input: true,
            resize: true,
            kill: true,
            transfer: true,
            run: true,
            headless: true,
            suspend: false,
            destroy: false,
          },
          brokerAuth: false,
        },
      ],
      spawnDefaults: { agent: 'claude', target: 'local' },
      configRevision: expect.toBeString(),
      targetErrors: [],
      sources: [],
    },
  ],
  ['fleet.list', { fleet: [] }],
  ['session.detach', {}],
  ['events.read', { events: [], cursor: expect.toBeString(), more: false }],
] as const)('it admits %s over TCP from a principal', async (method, reply) => {
  await using ctx = await setupTest();

  const client = await ctx.daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  expect(client.sendRequest(method, {}, 'gw')).resolves.toStrictEqual(reply);
});

test.each([
  ['sources.list', 'bad_args'],
  ['sources.interpret', 'bad_args'],
  ['git.probe', 'bad_args'],
  ['session.spawn', 'bad_args'],
  ['session.kill', 'no_such_session'],
  ['session.ack', 'no_such_session'],
  ['session.forget', 'no_such_session'],
  ['session.resumeCommand', 'no_such_session'],
  ['session.update', 'no_such_session'],
  ['session.attach', 'no_such_session'],
  ['session.input', 'no_such_session'],
  ['session.submit', 'no_such_session'],
  ['session.resize', 'bad_args'],
  ['session.screen', 'no_such_session'],
  ['session.eject', 'no_such_session'],
  ['session.adopt', 'no_such_session'],
  ['permission.respond', 'bad_args'],
  ['session.get', 'no_such_session'],
  ['session.read', 'no_such_session'],
  ['session.message', 'bad_args'],
  ['session.tap', 'no_such_session'],
  ['message.get', 'bad_args'],
  ['report.get', 'bad_args'],
  ['message.ack', 'bad_args'],
])('it admits %s over TCP from a principal, which answers it with %s', async (method, code) => {
  await using ctx = await setupTest();

  const client = await ctx.daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  expect(client.sendRequest(method, {}, 'gw')).rejects.toMatchObject({ code });
});

test('it answers a method the protocol does not define from a principal as unknown', async () => {
  await using ctx = await setupTest();

  const client = await ctx.daemon.openClient({ principal: 'gw' });

  expect(client.sendRequest('daemon.nuke', {})).rejects.toMatchObject({
    code: 'unknown_method',
    message: "unknown method 'daemon.nuke'",
  });
});
