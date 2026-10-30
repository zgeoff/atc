import { GATEWAY_REGISTRY_SCHEMA } from '@atcx/contract';
import type { z } from 'zod';
import type { GatewayRegistry, RegistryDaemon } from './types';

type ParsedGatewayRegistry =
  | { readonly ok: true; readonly registry: GatewayRegistry }
  | { readonly ok: false; readonly errors: readonly string[] };

export function parseGatewayRegistry(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>>,
): ParsedGatewayRegistry {
  const parsed = GATEWAY_REGISTRY_SCHEMA.safeParse(raw);

  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => formatRegistryIssue(issue)) };
  }

  const daemons = new Map<string, RegistryDaemon>();

  const errors: string[] = [];

  for (const [name, entry] of Object.entries(parsed.data.daemons)) {
    const tokenVar = `ATC_GATEWAY_TOKEN_${name.toUpperCase().replaceAll('-', '_')}`;
    const token = env[tokenVar];

    if (token === undefined || token === '') {
      errors.push(`daemon '${name}' has no token: set ${tokenVar}`);
    } else {
      daemons.set(name, {
        name,
        address: entry.address,
        daemonID: entry.daemonID,
        incarnation: entry.daemonID.slice(0, 8),
        token,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, registry: { daemons, defaultDaemon: parsed.data.defaultDaemon } };
}

// An issue inside one daemon's entry names that daemon.
function formatRegistryIssue(issue: z.core.$ZodIssue): string {
  const [field, name] = issue.path;

  if (field !== 'daemons' || typeof name !== 'string') {
    return issue.message;
  }

  return issue.code === 'invalid_key'
    ? `daemon name '${name}' ${issue.message}`
    : `daemon '${name}' ${issue.message}`;
}
