import { expect, test } from 'bun:test';
import { collectRemoteDaemons } from './collect-remote-daemons';

test('it holds no daemons when the config sets none', () => {
  expect(collectRemoteDaemons(undefined, '/home/a')).toStrictEqual({
    daemons: new Map(),
    errors: [],
  });
});

test('it reads a daemon whose token comes from a file under the home', () => {
  expect(
    collectRemoteDaemons(
      {
        box: {
          address: 'box.example.ts.net:7420',
          principal: 'laptop',
          tokenFile: '~/.config/atc/box.token',
        },
      },
      '/home/a',
    ),
  ).toStrictEqual({
    daemons: new Map([
      [
        'box',
        {
          name: 'box',
          host: 'box.example.ts.net',
          port: 7420,
          token: { kind: 'file', path: '/home/a/.config/atc/box.token' },
          principal: 'laptop',
        },
      ],
    ]),
    errors: [],
  });
});

test('it reads a daemon whose token comes from a command on a bracketed IPv6 address', () => {
  expect(
    collectRemoteDaemons(
      {
        'lab-2': {
          address: '[fd7a:115c:a1e0::9]:7420',
          principal: 'laptop',
          tokenCommand: ['op', 'read', 'op://example/atc-lab-2/token'],
        },
      },
      '/home/a',
    ),
  ).toStrictEqual({
    daemons: new Map([
      [
        'lab-2',
        {
          name: 'lab-2',
          host: 'fd7a:115c:a1e0::9',
          port: 7420,
          token: { kind: 'command', argv: ['op', 'read', 'op://example/atc-lab-2/token'] },
          principal: 'laptop',
        },
      ],
    ]),
    errors: [],
  });
});

test('it refuses a daemon that holds its token inline and keeps the other daemons', () => {
  expect(
    collectRemoteDaemons(
      {
        box: { address: '10.0.0.4:7420', principal: 'laptop', tokenFile: '/etc/atc/box.token' },
        lab: { address: '10.0.0.5:7420', principal: 'laptop', token: 'not-a-real-token' },
      },
      '/home/a',
    ),
  ).toStrictEqual({
    daemons: new Map([
      [
        'box',
        {
          name: 'box',
          host: '10.0.0.4',
          port: 7420,
          token: { kind: 'file', path: '/etc/atc/box.token' },
          principal: 'laptop',
        },
      ],
    ]),
    errors: [
      'daemons.lab: a token never goes in the config; set tokenFile or tokenCommand instead',
    ],
  });
});

test('it refuses a daemon that sets both a token file and a token command', () => {
  expect(
    collectRemoteDaemons(
      {
        box: {
          address: '10.0.0.4:7420',
          principal: 'laptop',
          tokenFile: '/etc/atc/box.token',
          tokenCommand: ['cat', '/etc/atc/box.token'],
        },
      },
      '/home/a',
    ).errors,
  ).toStrictEqual(['daemons.box: set exactly one of tokenFile and tokenCommand']);
});

test('it refuses a daemon that sets no token source', () => {
  expect(
    collectRemoteDaemons({ box: { address: '10.0.0.4:7420', principal: 'laptop' } }, '/home/a')
      .errors,
  ).toStrictEqual(['daemons.box: set exactly one of tokenFile and tokenCommand']);
});

test('it refuses a daemon that sets no principal', () => {
  expect(
    collectRemoteDaemons(
      { box: { address: '10.0.0.4:7420', tokenFile: '/etc/atc/box.token' } },
      '/home/a',
    ).errors,
  ).toStrictEqual([
    "daemons.box: principal must name a principal in the daemon's own principals map",
  ]);
});

test('it refuses a relative token file', () => {
  expect(
    collectRemoteDaemons(
      { box: { address: '10.0.0.4:7420', principal: 'laptop', tokenFile: 'box.token' } },
      '/home/a',
    ).errors,
  ).toStrictEqual(['daemons.box: tokenFile must be an absolute path or one under ~']);
});

test('it refuses an empty token command', () => {
  expect(
    collectRemoteDaemons(
      { box: { address: '10.0.0.4:7420', principal: 'laptop', tokenCommand: [] } },
      '/home/a',
    ).errors,
  ).toStrictEqual(['daemons.box: tokenCommand must be a non-empty array of non-empty strings']);
});

test.each([
  ['no port', '10.0.0.4'],
  ['port 0', '10.0.0.4:0'],
  ['a port over 65535', '10.0.0.4:70000'],
])('it refuses an address with %s', (_label, address) => {
  expect(
    collectRemoteDaemons(
      { box: { address, principal: 'laptop', tokenFile: '/etc/atc/box.token' } },
      '/home/a',
    ).errors,
  ).toStrictEqual(['daemons.box: address must be <host>:<port> with a port from 1 to 65535']);
});

test('it refuses a daemon name the gateway would refuse', () => {
  expect(
    collectRemoteDaemons(
      {
        'Box.1': { address: '10.0.0.4:7420', principal: 'laptop', tokenFile: '/etc/atc/box.token' },
      },
      '/home/a',
    ).errors,
  ).toStrictEqual(['daemons.Box.1: a daemon name must match ^[a-z][a-z0-9-]{0,30}$']);
});

test('it refuses a daemon entry that is not an object', () => {
  expect(collectRemoteDaemons({ box: '10.0.0.4:7420' }, '/home/a').errors).toStrictEqual([
    'daemons.box: a daemon must be an object with address, principal, and tokenFile or tokenCommand',
  ]);
});

test('it holds no daemons, with an error, when daemons is an array', () => {
  expect(collectRemoteDaemons([], '/home/a')).toStrictEqual({
    daemons: new Map(),
    errors: ['daemons must be an object of named daemons'],
  });
});
