import { GRANT_SCOPES } from '@atcx/contract';
import type { GrantScope } from '@atcx/contract';
import { z } from 'zod';
import { SERVICE_TOKEN_PREFIX } from './service-token-prefix';

export interface ServiceClient {
  readonly name: string;
  readonly scopes: readonly GrantScope[];
  readonly tokens: readonly string[];
}

export interface ServiceTokenFile {
  readonly resource: string;
  readonly clients: readonly ServiceClient[];
}

export type ParsedServiceTokenFile =
  | { readonly ok: true; readonly file: ServiceTokenFile }
  | { readonly ok: false; readonly reason: string };

const TOKEN_PATTERN = new RegExp(`^${SERVICE_TOKEN_PREFIX}[A-Za-z0-9_-]{32,}$`, 'u');

// None of these messages holds the value it judges, because a value in the
// file may be a token.
const NAME_MESSAGE = 'a client name must match [a-z][a-z0-9-]{0,31}';
const TOKEN_MESSAGE = `a token must be ${SERVICE_TOKEN_PREFIX} followed by 32 or more of A-Z, a-z, 0-9, _ and -`;
const ScopeSchema = z.enum(GRANT_SCOPES, 'a scope must be one the gateway knows');
const TokenSchema = z.string().regex(TOKEN_PATTERN, TOKEN_MESSAGE);

const ClientSchema = z.strictObject({
  scopes: z.array(ScopeSchema).min(1, 'must name at least one scope'),
  tokens: z.array(TokenSchema).min(1, 'must hold 1 or 2 tokens').max(2, 'must hold 1 or 2 tokens'),
});

const NameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u, NAME_MESSAGE);

const ServiceTokenFileSchema = z.strictObject({
  resource: z.string().min(1, 'must be the resource URL the gateway serves'),
  clients: z
    .record(NameSchema, ClientSchema)
    .refine((clients) => Object.keys(clients).length > 0, 'must name at least one client'),
});

export function parseServiceTokenFile(text: string): ParsedServiceTokenFile {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's own message quotes the text.
    return { ok: false, reason: 'the file is not valid JSON' };
  }

  const parsed = ServiceTokenFileSchema.safeParse(raw);

  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map(formatIssue).join('; ') };
  }

  const clients = Object.entries(parsed.data.clients).map(([name, client]): ServiceClient => ({
    name,
    scopes: [...new Set(client.scopes)],
    tokens: client.tokens,
  }));

  const tokens = clients.flatMap((client) => client.tokens);

  if (new Set(tokens).size !== tokens.length) {
    return { ok: false, reason: 'the same token appears more than once' };
  }

  return { ok: true, file: { resource: parsed.data.resource, clients } };
}

function formatIssue(issue: z.core.$ZodIssue): string {
  // A rejected key may be a misplaced token, so the message leaves it out.
  if (issue.code === 'unrecognized_keys') {
    return `${formatPath(issue.path)}has a field the file does not take`;
  }

  if (issue.code === 'invalid_key') {
    return NAME_MESSAGE;
  }

  return `${formatPath(issue.path)}${issue.message}`;
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return 'the file: ';
  }

  return `${path.map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${String(segment)}`)).join('')}: `.replace(
    /^\./u,
    '',
  );
}
