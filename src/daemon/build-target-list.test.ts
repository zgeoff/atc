import { expect, onTestFinished, test } from 'bun:test';
import { FixtureImpPort } from '../test-utils/fixture-imp-port';
import { buildTargetList } from './build-target-list';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

test('it lists an imp target as reaching the broker', () => {
  using port = new FixtureImpPort();

  const provider = new ImpProvider(port, {}, { atcBinary: null });

  onTestFinished(() => {
    provider.dispose();
  });

  const entries = buildTargetList(
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider }],
    null,
  );

  expect(entries).toStrictEqual([
    {
      id: 'box',
      provider: 'imp',
      identity: 'imp:test',
      available: true,
      default: false,
      capabilities: {
        spawn: true,
        attach: true,
        input: true,
        resize: true,
        kill: true,
        transfer: true,
        run: true,
        headless: false,
        suspend: true,
        destroy: true,
      },
      brokerAuth: true,
    },
  ]);
});

test('it lists the local target and a target without a provider as reaching no broker', () => {
  const entries = buildTargetList(
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: 'local-pty:test',
        provider: new LocalPTYProvider(),
      },
      { id: 'gone', kind: 'imp', options: {}, identity: 'imp:gone', provider: null },
    ],
    'local',
  );

  expect(entries).toStrictEqual([
    {
      id: 'local',
      provider: 'local-pty',
      identity: 'local-pty:test',
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
    {
      id: 'gone',
      provider: 'imp',
      identity: 'imp:gone',
      available: false,
      default: false,
      capabilities: {
        spawn: false,
        attach: false,
        input: false,
        resize: false,
        kill: false,
        transfer: false,
        run: false,
        headless: false,
        suspend: false,
        destroy: false,
      },
      brokerAuth: false,
    },
  ]);
});
