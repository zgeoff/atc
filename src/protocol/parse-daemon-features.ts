import type { DaemonFeature } from './daemon-features';
import { DAEMON_FEATURES } from './daemon-features';

/**
 * Reads the features a `daemon.hello` answer announces. A missing or
 * malformed list, which an older daemon sends, is no features, and a name
 * this build does not know is dropped.
 */
export function parseDaemonFeatures(
  hello: Readonly<Record<string, unknown>>,
): ReadonlySet<DaemonFeature> {
  const announced = hello['features'];

  if (!Array.isArray(announced)) {
    return new Set();
  }

  return new Set(DAEMON_FEATURES.filter((feature) => announced.includes(feature)));
}
