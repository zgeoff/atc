import { isRecord } from '@atc/core';
import type { DaemonName } from '../fleet/session-key';
import type { SessionPlace } from './types';

// The name the TUI gives its own computer's daemon, which has no name in the config.
const LOCAL_DAEMON_NAME = 'local';

export function toDaemonLabel(daemon: DaemonName): string {
  return daemon ?? LOCAL_DAEMON_NAME;
}

// The place a descriptor carries. A daemon built before the field existed sends none, so its
// sessions group by daemon and target.
export function toSessionPlace(place: unknown, daemon: DaemonName, targetID: string): SessionPlace {
  if (isRecord(place) && typeof place['key'] === 'string' && typeof place['label'] === 'string') {
    return { key: place['key'], label: place['label'] };
  }

  return { key: `daemon:${toDaemonLabel(daemon)}:${targetID}`, label: targetID };
}
