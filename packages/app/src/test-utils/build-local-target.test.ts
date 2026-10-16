import { expect, test } from 'bun:test';
import { LocalPTYProvider } from '@atc/execution-local';
import { buildLocalTarget } from './build-local-target';

test('it builds the local target on the local pseudo-terminal provider', () => {
  const target = buildLocalTarget();

  expect(target).toMatchObject({
    id: 'local',
    kind: 'local-pty',
    options: {},
    identity: 'local-pty:44136fa355b3678a',
  });

  expect(target.provider).toBeInstanceOf(LocalPTYProvider);
});
