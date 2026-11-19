import { findFlagValue } from '@atc/plugin-api';
import { z } from 'zod';

const INLINE_SETTINGS_SCHEMA = z.looseObject({
  env: z.record(z.string(), z.unknown()).optional(),
  apiKeyHelper: z.unknown().optional(),
});

export interface InlineSettings {
  readonly env: Readonly<Record<string, unknown>>;
  readonly hasAPIKeyHelper: boolean;
}

export function parseInlineSettings(args: readonly string[]): InlineSettings {
  const inline = findFlagValue(args, ['--settings']);

  if (inline === null) {
    return { env: {}, hasAPIKeyHelper: false };
  }

  let json: unknown;

  try {
    json = JSON.parse(inline);
  } catch {
    return { env: {}, hasAPIKeyHelper: false };
  }

  const parsed = INLINE_SETTINGS_SCHEMA.safeParse(json);

  return parsed.success
    ? { env: parsed.data.env ?? {}, hasAPIKeyHelper: parsed.data.apiKeyHelper !== undefined }
    : { env: {}, hasAPIKeyHelper: false };
}
