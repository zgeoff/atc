import { readFileSync } from 'node:fs';
import { parseGatewayRegistry } from './parse-gateway-registry';
import type { GatewayRegistry } from './types';

type LoadedGatewayRegistry =
  | { readonly ok: true; readonly registry: GatewayRegistry }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Reads the registry file and parses it with the tokens from the
 * environment. An unreadable file or one that is not JSON refuses the
 * registry like any other problem in it.
 */
export function loadGatewayRegistry(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
): LoadedGatewayRegistry {
  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return { ok: false, errors: [`cannot read the registry at ${path}: ${detail}`] };
  }

  return parseGatewayRegistry(raw, env);
}
