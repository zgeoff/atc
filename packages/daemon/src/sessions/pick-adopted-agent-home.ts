import type { HarnessStart } from '@atc/plugin-api';

export function pickAdoptedAgentHome(
  start: HarnessStart | undefined,
  stored: string | undefined,
  planned: string | undefined,
): string | undefined {
  return (start?.created ?? true) ? planned : (stored ?? planned);
}
