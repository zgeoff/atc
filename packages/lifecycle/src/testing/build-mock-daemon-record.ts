import { mergeDeep } from '@atc/test-utils';
import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import type { DaemonRecord } from '../find-daemon-record';

export function buildMockDaemonRecord(
  overrides: MockOverrides<DaemonRecord, keyof DaemonRecord> = {},
): DaemonRecord {
  const dir = faker.system.directoryPath();

  return mergeDeep<DaemonRecord>(
    {
      pid: faker.number.int({ min: 2, max: 4_194_304 }),
      socketPath: `${dir}/atc-daemon.sock`,
      reporterSocketPath: `${dir}/atc.sock`,
      eventsSocketPath: null,
      listenPort: null,
    },
    overrides,
  );
}
