import { PROTOCOL_V } from '@atc/protocol/wire';
import type { MockOverrides } from '@atc/test-utils';
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
      protocol: PROTOCOL_V,
    },
    overrides,
  );
}
