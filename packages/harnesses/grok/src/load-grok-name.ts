import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HostFiles, NameUpdate } from '@atc/plugin-api';
import { buildOptionalString } from '@atcx/contract/schema';
import { z } from 'zod';

export async function loadGrokName(
  home: string,
  source: string,
  namedBy: 'user' | 'auto' | 'agent',
  files: HostFiles,
): Promise<NameUpdate | null> {
  const lines = await files.readMatchingLines(source, '');

  // grok files a session under the directory it started in, so a gone `source` falls back to the
  // same session id under any directory in `home`
  const summary =
    (lines === null ? null : parseSummary(lines.join('\n'))) ??
    readSummary(readGrokSummary(home, source));

  return summary === null ? null : buildNameUpdate(summary, namedBy);
}

// The fields of a session's summary.json a name comes from. A wrong-typed
// title or summary reads as absent.
const SUMMARY_SCHEMA = z.object({
  title_is_manual: z.unknown().optional(),
  generated_title: buildOptionalString(),
  session_summary: buildOptionalString(),
});

type GrokSummary = z.infer<typeof SUMMARY_SCHEMA>;

function parseSummary(text: string): GrokSummary | null {
  try {
    const parsed = SUMMARY_SCHEMA.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readSummary(source: string | null): GrokSummary | null {
  if (source === null) {
    return null;
  }

  try {
    return parseSummary(readFileSync(source, 'utf8'));
  } catch {
    return null;
  }
}

function readGrokSummary(home: string, source: string): string | null {
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

function buildNameUpdate(
  summary: GrokSummary,
  namedBy: 'user' | 'auto' | 'agent',
): NameUpdate | null {
  const title = summary.generated_title ?? '';
  const sessionSummary = summary.session_summary ?? '';

  // a title the person set in grok wins over every name, a name typed in atc included
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
