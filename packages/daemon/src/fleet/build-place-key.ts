import { createHash } from 'node:crypto';
import { sortJSONKeys } from '@atc/core';
import type { PlaceParts } from '@atc/plugin-api';

interface PlaceKeyInput {
  readonly provider: string;

  // absent for a provider with no place rule, which has daemon scope
  readonly placeParts: PlaceParts | undefined;
  readonly daemonID: string;
  readonly targetID: string;
}

export function buildPlaceKey(input: PlaceKeyInput): string {
  if (input.placeParts === undefined || input.placeParts.scope === 'daemon') {
    return `daemon:${input.daemonID}:${input.targetID}`;
  }

  const digest = createHash('sha256')
    .update(JSON.stringify(sortJSONKeys(input.placeParts.parts, 'code-unit')))
    .digest('hex')
    .slice(0, 16);

  return `${input.provider}:${input.placeParts.version}:${digest}`;
}
