import { startTestDaemon as startDaemonHarness } from '@atc/daemon/testing';
import type { StartedTestDaemon, TestDaemonConfig } from '@atc/daemon/testing';
import { buildLocalTarget } from './build-local-target';

export function startTestDaemon<const Config extends TestDaemonConfig = TestDaemonConfig>(
  config?: Config,
): Promise<StartedTestDaemon<Config>> {
  return startDaemonHarness({ ...config, defaultTargets: () => [buildLocalTarget()] });
}
