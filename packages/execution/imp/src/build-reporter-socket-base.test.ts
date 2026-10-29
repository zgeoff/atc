import { expect, test } from 'bun:test';
import { buildReporterSocketBase } from './build-reporter-socket-base';

test("it places a session's reporter socket under the guest folder's run folder by a short name", () => {
  expect(buildReporterSocketBase('/scratch/atc', '7F3A-90bc-41d2-8e55-0a1b2c3d4e5f')).toBe(
    '/scratch/atc/run/7f3a90bc41d28e55',
  );
});
