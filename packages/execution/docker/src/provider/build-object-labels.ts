import type { Labels } from '../engine/types';

export interface HostIdentity {
  readonly target: string;
  readonly host: string;
  readonly daemon: string;
  readonly boot: string;
}

// The labels every object of a host carries. A container adds its session and a host volume adds
// its id.
export function buildObjectLabels(
  identity: HostIdentity,
  extra: Readonly<{ session?: string; hostID?: string }> = {},
): Labels {
  return {
    'atc.target': identity.target,
    'atc.host': identity.host,
    'atc.daemon': identity.daemon,
    'atc.boot': identity.boot,
    ...(extra.session === undefined ? {} : { 'atc.session': extra.session }),
    ...(extra.hostID === undefined ? {} : { 'atc.host-id': extra.hostID }),
  };
}
