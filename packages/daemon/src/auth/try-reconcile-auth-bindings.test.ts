import { expect, mock, test } from 'bun:test';
import type { CredentialBroker } from '@atc/plugin-api';
import { buildMockFleetEntry } from '@atc/store/testing';
import { buildStubLog } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import type { SessionID } from '@atcx/contract';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubCredentialBroker } from '../testing/build-stub-credential-broker';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { tryReconcileAuthBindings } from './try-reconcile-auth-bindings';

type ReconcileBindings = (
  findHost: (target: string) => CredentialBroker | null,
  listedHostKeys: ReadonlySet<SessionID>,
  log: (line: string) => void,
) => Promise<void>;

test('it settles the bindings with each fleet host listed and each target broker found', async () => {
  const broker = buildStubCredentialBroker();
  const reconcileBindings = mock<ReconcileBindings>(() => Promise.resolve());

  const targets = new Map([
    [
      'remote',
      buildMockExecutionTarget({
        id: 'remote',
        identity: 'remote:test',
        provider: buildStubMemoryProvider({ brokerAuth: broker }),
      }),
    ],
  ]);

  const settled = await tryReconcileAuthBindings(
    { reconcileBindings },
    {
      loadFleet: () =>
        Promise.resolve([
          buildMockFleetEntry({ sessionID: toSessionID('s-1'), hostKey: toSessionID('s-0') }),
          buildMockFleetEntry({ sessionID: toSessionID('s-2') }),
        ]),
    },
    targets,
    buildStubLog().log,
  );

  const [findHost, listed] = reconcileBindings.mock.calls[0] ?? [];

  expect(settled).toBeTrue();
  expect(listed).toStrictEqual(new Set([toSessionID('s-0'), toSessionID('s-2')]));
  expect(findHost?.('remote')).toBe(broker);
  expect(findHost?.('local')).toBeNull();
});

test('it logs a settle that fails and resolves false', async () => {
  const recorder = buildStubLog();

  const settled = await tryReconcileAuthBindings(
    { reconcileBindings: () => Promise.reject(new Error('the broker is unreachable')) },
    { loadFleet: () => Promise.resolve([]) },
    new Map(),
    recorder.log,
  );

  expect(settled).toBeFalse();

  expect(recorder.lines).toStrictEqual([
    'atc could not settle runtime auth bindings (the broker is unreachable)',
  ]);
});
