import { expect, test } from 'bun:test';
import { SESSION_DESCRIPTOR_SCHEMA } from './session-descriptor';

function setupTest() {
  const descriptor = {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    name: 'bakery',
    cwd: '/srv/work/bakery',
    state: 'running',
    unread: false,
    lastMsg: 'working',
    agent: 'claude',
    pinned: false,
    lastAttachedAt: 1,
    repoRoot: '/srv/work/bakery',
    namedBy: 'user',
    createdAt: 1,
    kind: 'pty',
    alive: true,
    canEject: false,
    locator: { daemonID: 'a1b2c3d4-0000-4000-8000-000000000002', targetID: 'box' },
    lifecycle: { desired: 'run', vm: 'awake', harness: 'running', attachment: 'attached' },
  };

  return { descriptor };
}

test('it accepts a session with no host', () => {
  const ctx = setupTest();
  const result = SESSION_DESCRIPTOR_SCHEMA.safeParse(ctx.descriptor);

  expect(result.data).not.toContainKey('host');
});

test('it accepts a host with a name, an id and an issuer', () => {
  const ctx = setupTest();

  const result = SESSION_DESCRIPTOR_SCHEMA.safeParse({
    ...ctx.descriptor,
    host: { name: 'box-bakery', id: 'host-7', issuer: 'https://hosts.example.test' },
  });

  expect(result.data?.host).toStrictEqual({
    name: 'box-bakery',
    id: 'host-7',
    issuer: 'https://hosts.example.test',
  });
});

test('it accepts a host that has only a name', () => {
  const ctx = setupTest();

  const result = SESSION_DESCRIPTOR_SCHEMA.safeParse({
    ...ctx.descriptor,
    host: { name: 'box-bakery' },
  });

  expect(result.data?.host).toStrictEqual({ name: 'box-bakery' });
});

test('it rejects a host with no name', () => {
  const ctx = setupTest();

  const result = SESSION_DESCRIPTOR_SCHEMA.safeParse({
    ...ctx.descriptor,
    host: { id: 'host-7' },
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['host', 'name'] });
});

test('it rejects a host id that is not text', () => {
  const ctx = setupTest();

  const result = SESSION_DESCRIPTOR_SCHEMA.safeParse({
    ...ctx.descriptor,
    host: { name: 'box-bakery', id: 7 },
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['host', 'id'] });
});
