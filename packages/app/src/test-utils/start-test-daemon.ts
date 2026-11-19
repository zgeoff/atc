import { startTestDaemon as startDaemonHarness } from '@atc/daemon/test-utils/start-test-daemon';
import type { StartedTestDaemon, TestDaemonConfig } from '@atc/daemon/test-utils/start-test-daemon';
import { buildLocalTarget } from './build-local-target';

export function startTestDaemon<const Config extends TestDaemonConfig = TestDaemonConfig>(
  config?: Config,
): Promise<StartedTestDaemon<Config>> {
  return startDaemonHarness({ ...config, defaultTargets: () => [buildLocalTarget()] });
}
