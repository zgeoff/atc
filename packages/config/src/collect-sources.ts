import { isRecord } from '@atc/core';
import { resolveHomeDir } from '@atcx/contract/light';
import { z } from 'zod';
import { GITHUB_OWNER_PATTERN } from './github-owner-pattern';
import { normalizeConfigDir } from './normalize-config-dir';

// One workspace source the daemon offers, with every default applied.
export type SourceEntry =
  | { readonly id: string; readonly kind: 'dirs'; readonly roots: readonly string[] }
  | {
      readonly id: string;
      readonly kind: 'github';
      readonly owner: string | null;
      readonly bin: string;
    }
  | { readonly id: string; readonly kind: 'git' };

interface CollectedSources {
  readonly sources: SourceEntry[];

  // One line per problem, each starting with the entry it refused.
  readonly errors: string[];
}

export function collectSources(raw: unknown, home: string = resolveHomeDir()): CollectedSources {
  if (!isRecord(raw) || Array.isArray(raw)) {
    return { sources: [], errors: ['sources must be an object of source entries'] };
  }

  const sources: SourceEntry[] = [];
  const errors: string[] = [];

  for (const [id, entry] of Object.entries(raw)) {
    const parsed = parseSourceEntry(id, entry, home);

    if ('problems' in parsed) {
      errors.push(...parsed.problems.map((problem) => `sources.${id}: ${problem}`));
    } else if (parsed.kind === 'dirs' && sources.some((source) => source.kind === 'dirs')) {
      // an adopt opens on the one directory source, so a second has no use
      errors.push(`sources.${id}: only one dirs source is allowed`);
    } else {
      sources.push(parsed);
    }
  }

  return { sources, errors };
}

function parseSourceEntry(
  id: string,
  raw: unknown,
  home: string,
): SourceEntry | { readonly problems: readonly string[] } {
  const idProblem = findIDProblem(id);

  if (idProblem !== null) {
    return { problems: [idProblem] };
  }

  if (!isRecord(raw) || Array.isArray(raw)) {
    return { problems: ['the entry must be an object'] };
  }

  const kind = pickKind(id, raw['kind']);

  if (typeof kind !== 'string') {
    return { problems: [kind.problem] };
  }

  const parsed = buildEntrySchemas(id, home)[kind].safeParse(raw);

  return parsed.success
    ? parsed.data
    : { problems: collectIssueProblems(kind, parsed.error.issues) };
}

// The longest id a source request takes.
const MAX_ID_LENGTH = 64;

function findIDProblem(id: string): string | null {
  if (id === '' || id.length > MAX_ID_LENGTH) {
    return `the id must be 1 to ${MAX_ID_LENGTH} characters`;
  }

  if (id === '__proto__') {
    return 'the id cannot be used';
  }

  // JavaScript moves an integer key to the front of an object, so the
  // entry could never keep its place in the picker's order.
  if (/^\d+$/u.test(id)) {
    return 'the id cannot be digits alone';
  }

  return null;
}

export type SourceKind = 'dirs' | 'github' | 'git';

// The kinds, in the order an error lists them.
const KINDS: readonly SourceKind[] = ['dirs', 'git', 'github'];

// The kind an entry's `kind` selects, or the problem that refuses it. An
// absent kind is the id for a built-in id, and a problem for any other.
function pickKind(id: string, kind: unknown): SourceKind | { readonly problem: string } {
  const named = KINDS.find((candidate) => candidate === id);
  const selected = KINDS.find((candidate) => candidate === kind);
  const ids = `${KINDS.slice(0, -1).join(', ')}, or ${KINDS.at(-1)}`;

  if (kind === undefined) {
    return named ?? { problem: `kind is required for an id other than ${ids}` };
  }

  if (selected === undefined) {
    return { problem: `kind must be ${ids}` };
  }

  if (named !== undefined && named !== selected) {
    return { problem: `kind ${selected} contradicts the id ${named}` };
  }

  return selected;
}

// Each kind's fields, built into its entry; `kind` itself is checked
// before the entry reaches its schema.
function buildEntrySchemas(id: string, home: string) {
  return {
    dirs: z
      .strictObject({ kind: z.unknown().optional(), roots: z.array(z.string().min(1)).default([]) })
      .transform((fields): SourceEntry => ({
        id,
        kind: 'dirs',
        roots: fields.roots.map((root) => normalizeConfigDir(root, home)),
      })),
    github: z
      .strictObject({
        kind: z.unknown().optional(),
        owner: z.string().regex(GITHUB_OWNER_PATTERN).nullable().default(null),
        bin: z.string().min(1).default('gh'),
      })
      .transform((fields): SourceEntry => ({
        id,
        kind: 'github',
        owner: fields.owner,
        bin: fields.bin,
      })),
    git: z
      .strictObject({ kind: z.unknown().optional() })
      .transform((): SourceEntry => ({ id, kind: 'git' })),
  } satisfies Record<SourceKind, z.ZodType<SourceEntry>>;
}

// The problem each field reports for a value of the wrong type.
const FIELD_PROBLEMS: Readonly<Record<string, string>> = {
  roots: 'roots must be an array of non-empty strings',
  owner: 'owner is not a GitHub account or organization',
  bin: 'bin must be a non-empty string',
};

// One line per field a schema refused: an unknown field, a field of
// another kind, or a field of the wrong type.
function collectIssueProblems(kind: SourceKind, issues: readonly z.core.$ZodIssue[]): string[] {
  const problems = new Set<string>();

  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const name of issue.keys) {
        const problem = Object.hasOwn(FIELD_PROBLEMS, name)
          ? `${name} is not valid for kind ${kind}`
          : `unknown field ${name}`;

        problems.add(problem);
      }
    } else {
      const field = String(issue.path[0]);

      problems.add(FIELD_PROBLEMS[field] ?? issue.message);
    }
  }

  return [...problems];
}
