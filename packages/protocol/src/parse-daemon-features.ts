import type { DaemonFeature } from './daemon-features';
import { DAEMON_FEATURES } from './daemon-features';

export function parseDaemonFeatures(
  hello: Readonly<Record<string, unknown>>,
): ReadonlySet<DaemonFeature> {
  const announced = hello['features'];

  if (!Array.isArray(announced)) {
    return new Set();
  }

  return new Set(DAEMON_FEATURES.filter((feature) => announced.includes(feature)));
}
