import type { DaemonFeature } from '../hello/daemon-features';

// Each input field that changes behaviour, added inside a major version, with the feature a daemon
// must list in its hello answer before a client sends the field. A nested field is a dotted path.
export const FEATURE_INPUT_FIELDS = {
  'events.read': { from: 'events.read.from-start' },
} as const satisfies Readonly<Record<string, Readonly<Record<string, DaemonFeature>>>>;
