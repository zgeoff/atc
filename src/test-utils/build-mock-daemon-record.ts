import { faker } from '@faker-js/faker';
import type { DaemonRecord } from '../shared/find-daemon-record';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

/**
 * The record a daemon writes beside its state directory, for a daemon with
 * no events socket and no TCP listener. The pid and the socket paths are
 * arbitrary. Overrides replace the defaults field by field.
 */
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
