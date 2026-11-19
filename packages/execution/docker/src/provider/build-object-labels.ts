import type { Labels } from '../engine/types';

export interface HostIdentity {
  readonly target: string;
  readonly host: string;
  readonly daemon: string;
  readonly boot: string;
}

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
