import { createHash } from 'node:crypto';
import { sortJSONKeys } from '@atc/core';
import type { PlaceParts } from '@atc/plugin-api';

interface PlaceKeyInput {
  readonly provider: string;

  // absent for a provider with no place rule, which has daemon scope
  readonly placeParts: PlaceParts | undefined;
  readonly daemonID: string;
  readonly targetID: string;

  // the identity a session was saved with, for a session kept out of its target's place
  readonly savedIdentity?: string;
}

export function buildPlaceKey(input: PlaceKeyInput): string {
  if (input.savedIdentity !== undefined) {
    return buildDaemonKey([input.daemonID, input.targetID, input.savedIdentity]);
  }

  if (input.placeParts === undefined || input.placeParts.scope === 'daemon') {
    return buildDaemonKey([input.daemonID, input.targetID]);
  }

  const digest = createHash('sha256')
    .update(JSON.stringify(sortJSONKeys(input.placeParts.parts, 'code-unit')))
    .digest('hex')
    .slice(0, 16);

  return `${input.provider}:${input.placeParts.version}:${digest}`;
}

// Each part is percent-encoded, so no part holds the colon that separates them, and a key with
// a saved identity never equals the key of a target whose id holds that identity.
function buildDaemonKey(parts: readonly string[]): string {
  return ['daemon', ...parts.map((part) => encodeURIComponent(part))].join(':');
}
