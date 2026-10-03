import { expect, test } from 'bun:test';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { buildTargetList } from './build-target-list';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

test('it lists an imp target as reaching the broker', () => {
  using port = new FixtureImpPort();

  const provider = new ImpProvider(port, {}, { atcBinary: null });

  const [entry] = buildTargetList(
    [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider }],
    null,
  );

  provider.dispose();

  expect(entry).toMatchObject({ id: 'box', brokerAuth: true });
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

  expect(entries).toMatchObject([
    { id: 'local', brokerAuth: false },
    { id: 'gone', brokerAuth: false },
  ]);
});
