import { expect, test } from 'bun:test';
import { resolveRemoteDaemon } from './resolve-remote-daemon';

test('it resolves the daemon the name selects', () => {
  expect(
    resolveRemoteDaemon(
      {
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
        daemonErrors: [],
      },
      'box',
      '/home/a/.config/atc/config.json',
    ),
  ).toStrictEqual({
    ok: true,
    daemon: {
      name: 'box',
      host: '10.0.0.4',
      port: 7420,
      token: { kind: 'file', path: '/etc/atc/box.token' },
      principal: 'laptop',
    },
  });
});

test('it refuses a name whose entry broke a rule, with that rule', () => {
  expect(
    resolveRemoteDaemon(
      {
        daemons: new Map(),
        daemonErrors: [
          'daemons.lab: a token never goes in the config; set tokenFile or tokenCommand instead',
        ],
      },
      'lab',
      '/home/a/.config/atc/config.json',
    ),
  ).toStrictEqual({
    ok: false,
    message:
      'the daemons.lab entry of /home/a/.config/atc/config.json cannot be used: a token never goes in the config; set tokenFile or tokenCommand instead. atc did not fall back to the local daemon.',
  });
});

test('it refuses a name the map does not hold, with the names it holds', () => {
  expect(
    resolveRemoteDaemon(
      {
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
        daemonErrors: [],
      },
      'lab',
      '/home/a/.config/atc/config.json',
    ),
  ).toStrictEqual({
    ok: false,
    message:
      "the daemons map of /home/a/.config/atc/config.json holds no daemon 'lab'; it holds box. atc did not fall back to the local daemon.",
  });
});

test('it refuses a name when the map holds no daemons', () => {
  expect(
    resolveRemoteDaemon(
      { daemons: new Map(), daemonErrors: [] },
      'lab',
      '/home/a/.config/atc/config.json',
    ),
  ).toStrictEqual({
    ok: false,
    message:
      "the daemons map of /home/a/.config/atc/config.json holds no daemon 'lab'; it holds none. atc did not fall back to the local daemon.",
  });
});
