import { expect, test } from 'bun:test';
import { buildGatewayResult } from './build-gateway-result';
import { parseGatewayID } from './parse-gateway-id';

test('it rewrites every id of a session descriptor and keeps the agent session id', () => {
  const daemon = { name: 'cloud', incarnation: '0f6c2a8e' };

  const result = buildGatewayResult(
    'session.spawn',
    {
      session: {
        id: '2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c',
        parent: '5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
        children: ['7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d'],
        agentSessionID: 'a-11111111-2222-4333-8444-555555555555',
        name: 'auth-bug',
        locator: { daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30', targetID: 'local' },
      },
      warnings: ['dirty tree'],
    },
    daemon,
  );

  expect(result).toStrictEqual({
    session: {
      id: 'cloud.0f6c2a8e.2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c',
      parent: 'cloud.0f6c2a8e.5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
      children: ['cloud.0f6c2a8e.7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d'],
      agentSessionID: 'a-11111111-2222-4333-8444-555555555555',
      name: 'auth-bug',
      locator: { daemon: 'cloud', incarnation: '0f6c2a8e', targetID: 'local' },
    },
    warnings: ['dirty tree'],
  });
});

test('it rewrites the descriptors of a session list', () => {
  const result = buildGatewayResult(
    'session.list',
    {
      sessions: [
        { id: 's1', locator: { daemonID: 'd', targetID: 'local' } },
        { id: 's2', parent: 's1', locator: { daemonID: 'd', targetID: 'box' } },
      ],
    },
    { name: 'pc-1', incarnation: '9a1b2c3d' },
  );

  expect(result).toStrictEqual({
    sessions: [
      {
        id: 'pc-1.9a1b2c3d.s1',
        locator: { daemon: 'pc-1', incarnation: '9a1b2c3d', targetID: 'local' },
      },
      {
        id: 'pc-1.9a1b2c3d.s2',
        parent: 'pc-1.9a1b2c3d.s1',
        locator: { daemon: 'pc-1', incarnation: '9a1b2c3d', targetID: 'box' },
      },
    ],
  });
});

test('it rewrites the session of a session.get answer and leaves its text alone', () => {
  const result = buildGatewayResult(
    'session.get',
    {
      session: { id: 's1', locator: { daemonID: 'd', targetID: 'local' } },
      prompt: 'fix s1',
      pending: { message: 'allow edit?' },
      result: null,
      lastActivityAt: 5,
    },
    { name: 'cloud', incarnation: '0f6c2a8e' },
  );

  expect(result).toStrictEqual({
    session: {
      id: 'cloud.0f6c2a8e.s1',
      locator: { daemon: 'cloud', incarnation: '0f6c2a8e', targetID: 'local' },
    },
    prompt: 'fix s1',
    pending: { message: 'allow edit?' },
    result: null,
    lastActivityAt: 5,
  });
});

test('it rewrites every id of a message.get answer', () => {
  const result = buildGatewayResult(
    'message.get',
    {
      message: 'm-1',
      session: 's1',
      from: 'tester',
      text: 'ping',
      status: 'answered',
      turn: 't-9',
      answeredWith: ['m-0', 'm-1'],
    },
    { name: 'cloud', incarnation: '0f6c2a8e' },
  );

  expect(result).toStrictEqual({
    message: 'cloud.0f6c2a8e.m-1',
    session: 'cloud.0f6c2a8e.s1',
    from: 'tester',
    text: 'ping',
    status: 'answered',
    turn: 't-9',
    answeredWith: ['cloud.0f6c2a8e.m-0', 'cloud.0f6c2a8e.m-1'],
  });
});

test('it rewrites the session inside a structured turn', () => {
  const result = buildGatewayResult(
    'message.get',
    { message: 'm-1', session: 's1', turn: { id: 't-9', session: 's1' }, answeredWith: [] },
    { name: 'cloud', incarnation: '0f6c2a8e' },
  );

  expect(result).toStrictEqual({
    message: 'cloud.0f6c2a8e.m-1',
    session: 'cloud.0f6c2a8e.s1',
    turn: { id: 't-9', session: 'cloud.0f6c2a8e.s1' },
    answeredWith: [],
  });
});

test('it rewrites the message of session.message and message.ack answers', () => {
  const daemon = { name: 'cloud', incarnation: '0f6c2a8e' };

  expect(
    buildGatewayResult('session.message', { message: 'm-1', status: 'accepted' }, daemon),
  ).toStrictEqual({
    message: 'cloud.0f6c2a8e.m-1',
    status: 'accepted',
  });

  expect(
    buildGatewayResult('message.ack', { message: 'm-1', status: 'delivered' }, daemon),
  ).toStrictEqual({
    message: 'cloud.0f6c2a8e.m-1',
    status: 'delivered',
  });
});

test('it passes the opaque fields of an answer unchanged', () => {
  const answer = { command: 'claude --resume 2b7f0c1e-9a4d-4e8b-b1c2-3d4e5f6a7b8c' };

  expect(
    buildGatewayResult('session.resumeCommand', answer, { name: 'cloud', incarnation: '0f6c2a8e' }),
  ).toStrictEqual(answer);
});

test('it refuses to pass on the answer of a method without id rules', () => {
  expect(() =>
    buildGatewayResult('fleet.list', { fleet: [] }, { name: 'cloud', incarnation: '0f6c2a8e' }),
  ).toThrowWithMessage(Error, 'the gateway has no id rules for fleet.list');
});

test('it routes every rewritten id back to the daemon id it came from', () => {
  const cloud = {
    name: 'cloud',
    address: { host: '100.64.0.2', port: 8415 },
    daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
    incarnation: '0f6c2a8e',
    token: 't',
  };

  const registry = { daemons: new Map([['cloud', cloud]]), defaultDaemon: 'cloud' };

  const result = buildGatewayResult(
    'message.get',
    { message: 'm-1', session: 's1', answeredWith: ['m-0'] },
    cloud,
  );

  expect(parseGatewayID(String(result['message']), registry)).toMatchObject({ id: 'm-1' });
  expect(parseGatewayID(String(result['session']), registry)).toMatchObject({ id: 's1' });
  expect(result['answeredWith']).toStrictEqual(['cloud.0f6c2a8e.m-0']);
  expect(parseGatewayID('cloud.0f6c2a8e.m-0', registry)).toMatchObject({ id: 'm-0' });
});

test('it refuses to rewrite an events.read answer outside the event merge', () => {
  expect(() =>
    buildGatewayResult('events.read', { events: [] }, { name: 'cloud', incarnation: '0f6c2a8e' }),
  ).toThrowWithMessage(Error, 'an events.read answer is rewritten by the event merge');
});
