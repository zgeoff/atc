import { readFileSync } from 'node:fs';
import type { GatewayRegistry } from '../types';
import { parseGatewayRegistry } from './parse-gateway-registry';

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
