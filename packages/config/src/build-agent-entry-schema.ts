import { isRecord } from '@atc/core';
import type { AuthProfile, PluginConfigContext } from '@atc/plugin-api';
import { findPluginDirProblem } from '@atc/plugin-api';
import { z } from 'zod';
import type { AgentEntry, AgentKind, ParsedAgentEntry } from './agent-entry';

interface AgentEntryReadArgs {
  readonly entry: AgentEntry;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly authProfiles: ReadonlyMap<string, AuthProfile>;
}

export type AgentEntryRead = ParsedAgentEntry | { readonly problems: readonly string[] };

interface AgentEntrySpec {
  readonly kind: AgentKind;
  readonly fields: readonly string[];
  readonly defaultLabel: string;
  readonly read?: (args: AgentEntryReadArgs) => AgentEntryRead;
}

export function buildAgentEntrySchema(
  spec: AgentEntrySpec,
  context: PluginConfigContext,
): z.ZodType<ParsedAgentEntry> {
  return z.unknown().transform((raw, ctx) => {
    const read = parseAgentEntryFields(raw, spec, context);

    if ('problems' in read) {
      for (const message of read.problems) {
        ctx.addIssue({ code: 'custom', message });
      }

      return z.NEVER;
    }

    return read;
  });
}

function parseAgentEntryFields(
  raw: unknown,
  spec: AgentEntrySpec,
  context: PluginConfigContext,
): AgentEntryRead {
  if (!isRecord(raw) || Array.isArray(raw)) {
    return { problems: ['the entry must be an object'] };
  }

  const problems = collectFieldProblems(raw, spec, context.foreignFields);

  if (problems.length > 0) {
    return { problems };
  }

  const entry = buildEntry(context.entryID, spec, raw);

  return spec.read === undefined
    ? { entry, warnings: [] }
    : spec.read({ entry, raw, authProfiles: context.authProfiles });
}

// The fields every kind takes.
const COMMON_FIELDS: ReadonlySet<string> = new Set(['kind', 'label', 'mark', 'bin', 'args', 'env']);

function collectFieldProblems(
  raw: Readonly<Record<string, unknown>>,
  spec: AgentEntrySpec,
  foreignFields: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];

  for (const [name, value] of Object.entries(raw)) {
    if (!COMMON_FIELDS.has(name) && !spec.fields.includes(name)) {
      const problem = foreignFields.has(name)
        ? `${name} is not valid for kind ${spec.kind}`
        : `unknown field ${name}`;

      problems.push(problem);
      continue;
    }

    const problem = findFieldProblem(name, value);

    if (problem !== null) {
      problems.push(problem);
      continue;
    }

    if (name === 'env' && isStringRecord(value)) {
      problems.push(...collectEnvNameProblems(value));
    }
  }

  return problems;
}

interface FieldCheck {
  readonly schema: z.ZodType;
  readonly problem: string;
}

const NON_EMPTY_STRING = z.string().min(1);

// The type of each field that takes a plain type check, with the problem a
// value of another type reports. `kind` is checked before the entry
// reaches its kind, and `auth` by the kind's own check.
const FIELD_CHECKS: ReadonlyMap<string, FieldCheck> = new Map([
  ['label', { schema: NON_EMPTY_STRING, problem: 'label must be a non-empty string' }],
  ['mark', { schema: NON_EMPTY_STRING, problem: 'mark must be a non-empty string' }],
  ['bin', { schema: NON_EMPTY_STRING, problem: 'bin must be a non-empty string' }],
  ['baseURL', { schema: NON_EMPTY_STRING, problem: 'baseURL must be a non-empty string' }],
  [
    'apiKeyHelper',
    { schema: NON_EMPTY_STRING, problem: 'apiKeyHelper must be a non-empty string' },
  ],
  ['args', { schema: z.array(z.string()), problem: 'args must be an array of strings' }],
  [
    'env',
    { schema: z.record(z.string(), z.string()), problem: 'env must be an object of strings' },
  ],
  [
    'settings',
    { schema: z.record(z.string(), z.unknown()), problem: 'settings must be an object' },
  ],
  ['appServer', { schema: z.boolean(), problem: 'appServer must be true or false' }],
  [
    'pluginDirs',
    {
      schema: z.array(z.string().refine((directory) => findPluginDirProblem(directory) === null)),
      problem:
        'pluginDirs must be an array of absolute paths or paths that start with ~/, each without a .. segment or control characters',
    },
  ],
]);

// The problem with one field's value, or null.
function findFieldProblem(name: string, value: unknown): string | null {
  const check = FIELD_CHECKS.get(name);

  if (check === undefined || check.schema.safeParse(value).success) {
    return null;
  }

  return check.problem;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    Object.values(value).every((fieldValue) => typeof fieldValue === 'string')
  );
}

// A shell variable name, since a resume command sources the entry's env
// from a shell file.
const SHELL_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// An entry's value for an `ATC_` name would replace the one atc sets.
function collectEnvNameProblems(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).flatMap((key) => {
    if (!SHELL_VARIABLE_NAME.test(key)) {
      return [
        `env key ${JSON.stringify(key)} is not a variable name: use letters, digits and underscores, and start with a letter or underscore`,
      ];
    }

    return key.startsWith('ATC_')
      ? [`env must not set ${key}, which atc keeps for the variables it sets itself`]
      : [];
  });
}

// An entry with every default applied, from fields already checked. The id
// that is the kind's own shows the kind's label; any other id shows itself.
function buildEntry(
  id: string,
  spec: AgentEntrySpec,
  raw: Readonly<Record<string, unknown>>,
): AgentEntry {
  const label = raw['label'];
  const mark = raw['mark'];
  const bin = raw['bin'];
  const args = raw['args'];
  const env = raw['env'];
  const settings = raw['settings'];
  const baseURL = raw['baseURL'];
  const apiKeyHelper = raw['apiKeyHelper'];
  const appServer = raw['appServer'];
  const pluginDirs = raw['pluginDirs'];
  const markSource = typeof mark === 'string' ? mark : id;
  const defaultLabel = id === spec.kind ? spec.defaultLabel : id;

  return {
    id,
    kind: spec.kind,
    label: typeof label === 'string' ? label : defaultLabel,
    mark: String.fromCodePoint(markSource.codePointAt(0) ?? 0),
    bin: typeof bin === 'string' ? bin : spec.kind,
    args: Array.isArray(args) ? args.map(String) : [],
    env: isStringRecord(env) ? env : {},
    ...(isRecord(settings) ? { settings } : {}),
    ...(typeof baseURL === 'string' ? { baseURL } : {}),
    ...(typeof apiKeyHelper === 'string' ? { apiKeyHelper } : {}),
    ...(typeof appServer === 'boolean' ? { appServer } : {}),
    ...(Array.isArray(pluginDirs) && pluginDirs.length > 0
      ? { pluginDirs: pluginDirs.map(String) }
      : {}),
  };
}
