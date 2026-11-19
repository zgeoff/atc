import { buildShortName } from './build-short-name';

export function buildImpSessionName(sessionID: string): string {
  // The prefix plus 28 chars stays inside the 32-char session limit.
  return `atc-${buildShortName(sessionID, 28)}`;
}
