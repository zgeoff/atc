import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildOptionalString } from '@atc/core/build-optional-string';
import type { NameUpdate } from '@atc/plugin-api/agent-adapter';
import { z } from 'zod';

// The fields of a session's summary.json a name comes from. A wrong-typed
// title or summary reads as absent.
const SUMMARY_SCHEMA = z.object({
  title_is_manual: z.unknown().optional(),
  generated_title: buildOptionalString(),
  session_summary: buildOptionalString(),
});

type GrokSummary = z.infer<typeof SUMMARY_SCHEMA>;

/**
 * The name a Grok session's summary at `source` gives it, or null when it
 * gives none. When `source` is gone, the summary of the same session id
 * under any working directory in `home` stands in, since Grok files a
 * session under the directory it started in. A title the person set in
 * Grok wins over every name; Grok's own title, then its summary, never
 * override a name a person typed in atc.
 */
export function loadGrokName(
  home: string,
  source: string,
  namedBy: 'user' | 'auto' | 'agent',
): Promise<NameUpdate | null> {
  const summary = readSummary(source) ?? readSummary(findGrokSummary(home, source));
  const update = summary === null ? null : buildNameUpdate(summary, namedBy);

  return Promise.resolve(update);
}

function buildNameUpdate(
  summary: GrokSummary,
  namedBy: 'user' | 'auto' | 'agent',
): NameUpdate | null {
  const title = summary.generated_title ?? '';
  const sessionSummary = summary.session_summary ?? '';

  if (summary.title_is_manual === true && title !== '') {
    return { name: title, namedBy: 'agent' };
  }

  if (namedBy !== 'user' && title !== '') {
    return { name: title };
  }

  if (namedBy !== 'user' && sessionSummary !== '') {
    return { name: sessionSummary };
  }

  return null;
}

function readSummary(source: string | null): GrokSummary | null {
  if (source === null) {
    return null;
  }

  try {
    const parsed = SUMMARY_SCHEMA.safeParse(JSON.parse(readFileSync(source, 'utf8')));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function findGrokSummary(home: string, source: string): string | null {
  const sessionID = source.split('/').at(-2);

  if (sessionID === undefined || sessionID === '') {
    return null;
  }

  const root = join(home, 'sessions');

  try {
    const groups = readdirSync(root);

    return (
      groups
        .map((group) => join(root, group, sessionID, 'summary.json'))
        .find((candidate) => existsSync(candidate)) ?? null
    );
  } catch {
    return null;
  }
}
