import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseLaneLimits } from './parse-lane-limits.ts';
import { readOptionalText } from './read-optional-text.ts';
import { readWorkerCount } from './read-worker-count.ts';
import type { WorkerCountSources } from './read-worker-count.ts';

// A host with one worker runs each file slower than CI, and a test that passes there must not fail
// the push.
const slowHostTestTimeoutMs = 15_000;
const maxTestFiles = 50;

export type ReadConfigText = (path: string) => string | null;

export type ProbeFile = (path: string) => boolean;

export interface RelatedTestSources {
  readonly cwd: string;
  readonly readConfigText: ReadConfigText;
  readonly probeFile: ProbeFile;
}

export async function runRelatedTests(
  args: readonly string[],
  sources: Readonly<RelatedTestSources>,
  workerSources: Readonly<WorkerCountSources>,
): Promise<number> {
  const options = parseRelatedTestArgs(args);

  if (options.kind === 'invalid') {
    process.stderr.write(`run-related-tests: ${options.message}\n`);

    return 2;
  }

  const plan = buildRelatedTestPlan(options.paths, resolveRelatedTests(options.paths, sources));

  if (plan.kind === 'skip') {
    process.stdout.write(`run-related-tests: ${plan.message}\n`);

    return 0;
  }

  const workers = await readWorkerCount(workerSources);

  if (workers.kind === 'invalid') {
    process.stderr.write(`run-related-tests: ${workers.message}\n`);

    return 2;
  }

  const flags = [
    `--parallel=${workers.count}`,
    ...(workers.count === 1 ? [`--timeout=${slowHostTestTimeoutMs}`] : []),
  ];

  // bun test reads a bare argument as a name filter; the ./ makes it a path.
  const run = Bun.spawn(
    ['bun', 'run', 'test', ...flags, ...plan.tests.map((path) => `./${path}`)],
    { cwd: sources.cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
  );

  return run.exited;
}

export function resolveRelatedTests(
  paths: readonly string[],
  sources: Readonly<RelatedTestSources>,
): string[] {
  const lanes = [
    ...parseLaneLimits(sources.readConfigText(join(sources.cwd, '.oxlintrc.json'))).keys(),
  ];

  const ignored = parseTestIgnorePatterns(sources.readConfigText(join(sources.cwd, 'bunfig.toml')));

  const selected = new Set<string>();

  for (const path of paths) {
    const test = findRelatedTest(path, lanes);

    if (
      test !== undefined &&
      !ignored.some((pattern) => pattern.match(test)) &&
      sources.probeFile(join(sources.cwd, test))
    ) {
      selected.add(test);
    }
  }

  return [...selected];
}

// bun test exits 1 with no test run when every path it is given matches a pathIgnorePatterns entry.
function parseTestIgnorePatterns(configText: string | null): Bun.Glob[] {
  if (configText === null) {
    return [];
  }

  const patterns = findMember(findMember(parseBunConfig(configText), 'test'), 'pathIgnorePatterns');
  const listed: unknown[] = Array.isArray(patterns) ? patterns : [patterns];

  return listed.flatMap((pattern) => (typeof pattern === 'string' ? [new Bun.Glob(pattern)] : []));
}

function parseBunConfig(text: string): unknown {
  try {
    return Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(
      `cannot parse bunfig.toml: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function findMember(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;
}

type RelatedTestArgs =
  | { readonly kind: 'valid'; readonly paths: readonly string[] }
  | { readonly kind: 'invalid'; readonly message: string };

// parseArgs throws on an option it does not declare, which the caller reports as a refused input.
function parseRelatedTestArgs(args: readonly string[]): RelatedTestArgs {
  try {
    return {
      kind: 'valid',
      paths: parseArgs({ args: [...args], options: {}, allowPositionals: true }).positionals,
    };
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
}

type RelatedTestPlan =
  | { readonly kind: 'run'; readonly tests: readonly string[] }
  | { readonly kind: 'skip'; readonly message: string };

function buildRelatedTestPlan(paths: readonly string[], tests: readonly string[]): RelatedTestPlan {
  const shared = paths.find((path) => isSharedTestInput(path));

  if (shared !== undefined) {
    return {
      kind: 'skip',
      message: `skipped, because the branch changes ${shared}, a shared test helper or config; CI runs the full suite`,
    };
  }

  if (tests.length > maxTestFiles) {
    return {
      kind: 'skip',
      message: `skipped, because the branch has ${tests.length} related unit test files, over the cap of ${maxTestFiles}; CI runs the full suite`,
    };
  }

  if (tests.length === 0) {
    return { kind: 'skip', message: 'no related tests' };
  }

  return { kind: 'run', tests };
}

// A shared helper or a bunfig.toml reaches tests beyond the siblings of the files it changes.
function isSharedTestInput(path: string): boolean {
  return /(?:^|\/)test-utils\//u.test(path) || basename(path) === 'bunfig.toml';
}

const sourcePattern = /^(?<stem>.+?)(?:\.test)?(?<ext>\.tsx?)$/u;

function findRelatedTest(path: string, lanes: readonly string[]): string | undefined {
  const groups = sourcePattern.exec(path)?.groups;

  if (groups === undefined || path.endsWith('.d.ts') || isLaneFile(path, lanes)) {
    return undefined;
  }

  return `${groups['stem']}.test${groups['ext']}`;
}

// A lane's tests need a real system, such as a browser, a container or a live model API, and run
// only in CI.
function isLaneFile(path: string, lanes: readonly string[]): boolean {
  const stem = basename(path).replace(/(?:\.test)?\.tsx?$/u, '');

  return (
    /(?:^|\/)(?:e2e|[^/]+-e2e)\//u.test(path) || lanes.some((lane) => stem.endsWith(`.${lane}`))
  );
}

if (import.meta.main) {
  const exitCode = await runRelatedTests(
    process.argv.slice(2),
    { cwd: process.cwd(), readConfigText: readOptionalFileText, probeFile: existsSync },
    {
      env: process.env,
      cores: availableParallelism(),
      totalMemory: totalmem(),
      procRoot: '/proc',
      cgroupRoot: '/sys/fs/cgroup',
      readText: readOptionalText,
    },
  );

  process.exit(exitCode);
}

function readOptionalFileText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
