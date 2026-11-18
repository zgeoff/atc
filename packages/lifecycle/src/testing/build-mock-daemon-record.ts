import type { MockOverrides } from '@atc/test-utils';
import { PROTOCOL_VERSION } from '@atcx/contract/light';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { DaemonRecord } from '../read-daemon-record';

export function buildMockDaemonRecord(
  overrides: MockOverrides<DaemonRecord, keyof DaemonRecord> = {},
): DaemonRecord {
  const directory = faker.system.directoryPath();

  return mergeDeep<DaemonRecord>(
    {
      pid: faker.number.int({ min: 2, max: 4_194_304 }),
      socketPath: `${directory}/atc-daemon.sock`,
      reporterSocketPath: `${directory}/atc.sock`,
      eventsSocketPath: null,
      listenPort: null,
      protocol: PROTOCOL_VERSION,
    },
    overrides,
  );
}
