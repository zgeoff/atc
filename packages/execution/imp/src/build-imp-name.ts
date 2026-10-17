import { buildShortName } from './build-short-name';

export function buildImpName(impPrefix: string, hostKey: string): string {
  return `${impPrefix}${buildShortName(hostKey, 20)}`;
}
