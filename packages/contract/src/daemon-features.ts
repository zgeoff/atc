// A daemon lists in its hello reply the features that a release added
// within its major version, so a client learns what an older daemon of the
// same major lacks without comparing minor versions.
export const DAEMON_FEATURES = ['events.read.from-start'] as const;

export type DaemonFeature = (typeof DAEMON_FEATURES)[number];
