import { readFileSync } from 'node:fs';
import { parseGatewayRegistry } from './parse-gateway-registry';
import type { GatewayRegistry } from './types';

type LoadedGatewayRegistry =
  | { readonly ok: true; readonly registry: GatewayRegistry }
  | { readonly ok: false; readonly errors: readonly string[] };

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
