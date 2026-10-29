import { posix } from 'node:path';
import type { HostFiles, NameUpdate } from '@atc/plugin-api';
import { buildOptionalString } from '@atcx/contract/schema';
import { z } from 'zod';

export async function loadGrokName(
  home: string,
  source: string,
  namedBy: 'user' | 'auto' | 'agent',
  files: HostFiles,
): Promise<NameUpdate | null> {
  // grok files a session under the directory it started in, so a gone `source` falls back to the
  // same session id under any directory in `home`
  const found = await readSummary(files, source);

  const summary = found === null ? await readMovedSummary(files, home, source) : found;

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

async function readSummary(files: HostFiles, source: string): Promise<GrokSummary | null> {
  const lines = await files.readMatchingLines(source, '');

  return lines === null ? null : parseSummary(lines.join('\n'));
}

function parseSummary(text: string): GrokSummary | null {
  try {
    const parsed = SUMMARY_SCHEMA.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readMovedSummary(
  files: HostFiles,
  home: string,
  source: string,
): Promise<GrokSummary | null> {
  const sessionID = source.split('/').at(-2);

  if (sessionID === undefined || sessionID === '') {
    return null;
  }

  const root = posix.join(home, 'sessions');

  const groups = await files.readDirectory(root);

  for (const group of groups ?? []) {
    const candidate = posix.join(root, group, sessionID, 'summary.json');

    if (candidate === source) {
      continue;
    }

    // each read is a command on a remote host, so the scan stops at the first summary it finds
    // oxlint-disable-next-line no-await-in-loop
    const summary = await readSummary(files, candidate);

    if (summary !== null) {
      return summary;
    }
  }

  return null;
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
