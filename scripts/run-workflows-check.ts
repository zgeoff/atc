import { parseArgs } from 'node:util';
import { collectCommandNames } from './collect-command-names.ts';
import { parseShellWords } from './parse-shell-words.ts';
import type { RunProgram } from './run-program.ts';
import { runProgram } from './run-program.ts';

export type ChecksProfile = 'public' | 'private';

export interface WorkflowsCheckOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;

  // The workflow files to read, relative to the repo root; empty reads every one HEAD holds.
  readonly paths: readonly string[];

  // The bun-checks profile of the run; undefined when the check cannot see it, such as in a hook.
  readonly profile: ChecksProfile | undefined;

  readonly runProgram: RunProgram;
}

export interface WorkflowFinding {
  // Relative to the repo root.
  readonly path: string;

  readonly line: number;
  readonly message: string;
}

// GitHub runs no workflow from a subfolder of .github/workflows.
const workflowPathPattern = /^(?:\.github\/workflows|sync\/workflow-callers)\/[^/]+\.ya?ml$/u;

// The check reads the files as HEAD holds them, so a push checks what it sends.
export function runWorkflowsCheck(options: Readonly<WorkflowsCheckOptions>): WorkflowFinding[] {
  const tracked = runGit(options, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'])
    .split('\0')
    .filter((path) => workflowPathPattern.test(path));

  const asked = new Set(options.paths);

  const paths = options.paths.length === 0 ? tracked : tracked.filter((path) => asked.has(path));

  return paths.flatMap((path) =>
    collectWorkflowFindings(path, runGit(options, ['show', `HEAD:${path}`]), options.profile),
  );
}

function runGit(options: Readonly<WorkflowsCheckOptions>, args: readonly string[]): string {
  const result = options.runProgram(['git', ...args], { cwd: options.cwd, env: options.env });

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

interface Job {
  readonly id: string;
  readonly definition: unknown;
  readonly line: number;
}

interface WorkflowContext {
  readonly path: string;
  readonly profile: ChecksProfile | undefined;
  readonly workflow: unknown;
  readonly lines: readonly string[];
  readonly jobs: readonly Job[];
  readonly triggers: ReadonlySet<string>;
}

function collectWorkflowFindings(
  path: string,
  text: string,
  profile: ChecksProfile | undefined,
): WorkflowFinding[] {
  const workflow = parseWorkflow(text);

  if (workflow instanceof Error) {
    return [{ path, line: 1, message: `cannot parse the workflow: ${workflow.message}` }];
  }

  const lines = text.split('\n');

  const context: WorkflowContext = {
    path,
    profile,
    workflow,
    lines,
    jobs: collectJobs(findMember(workflow, 'jobs'), lines),
    triggers: collectTriggers(findMember(workflow, 'on')),
  };

  return [
    ...context.jobs.flatMap((job) => jobRules.flatMap((rule) => rule(context, job))),
    ...collectConcurrencyFindings(context),
    ...collectWorkflowRunFindings(context),
  ];
}

function parseWorkflow(text: string): unknown {
  try {
    return Bun.YAML.parse(text);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function collectJobs(jobs: unknown, lines: readonly string[]): Job[] {
  if (typeof jobs !== 'object' || jobs === null) {
    return [];
  }

  const jobsLine = lines.findIndex((line) => line.startsWith('jobs:'));

  return Object.entries(jobs).map(([id, definition]: readonly [string, unknown]) => ({
    id,
    definition,
    line: getJobLine(lines, jobsLine, id),
  }));
}

function getJobLine(lines: readonly string[], jobsLine: number, id: string): number {
  const keyPattern = new RegExp(`^\\s+${RegExp.escape(id)}:(?:\\s|$)`, 'u');

  const offset = lines.slice(jobsLine + 1).findIndex((line) => keyPattern.test(line));

  return offset === -1 ? Math.max(jobsLine + 1, 1) : jobsLine + offset + 2;
}

function findMember(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;
}

function collectTriggers(on: unknown): Set<string> {
  if (typeof on === 'string') {
    return new Set([on]);
  }

  if (isList(on)) {
    return new Set(on.filter((trigger): trigger is string => typeof trigger === 'string'));
  }

  return typeof on === 'object' && on !== null ? new Set(Object.keys(on)) : new Set();
}

// Array.isArray narrows to any[], which turns the type check off for each value.
function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

const jobRules: readonly ((context: WorkflowContext, job: Job) => WorkflowFinding[])[] = [
  collectRunFindings,
  collectTimeoutFindings,
  collectHeavyFindings,
  collectCacheFindings,
  collectCheckoutFindings,
];

function collectRunFindings(context: WorkflowContext, job: Job): WorkflowFinding[] {
  return collectSteps(job).flatMap((step, index) => {
    const run = findMember(step, 'run');
    const fault = typeof run === 'string' ? findRunFault(run) : undefined;

    return fault === undefined
      ? []
      : [
          {
            path: context.path,
            line: job.line,
            message: `job ${job.id}, ${formatStepLabel(step, index)}: the run ${fault}; a run holds one command on one line, and anything more goes in a script`,
          },
        ];
  });
}

function collectSteps(job: Job): readonly unknown[] {
  const steps = findMember(job.definition, 'steps');

  return isList(steps) ? steps : [];
}

const expressionOpening = `\${{`;

const shellKeywords = new Set(['if', 'for', 'while', 'case']);

function findRunFault(run: string): string | undefined {
  const command = run.trim();

  if (command.includes('\n')) {
    return 'spans more than one line';
  }

  if (command.includes(expressionOpening)) {
    return `holds a ${expressionOpening} }} expression, which belongs in env`;
  }

  const words = parseShellWords(command);
  const operator = words.find((word) => word.isOperator);

  if (operator !== undefined) {
    return `chains commands with \`${operator.text}\``;
  }

  const [first] = words;

  return first !== undefined && !first.isQuoted && shellKeywords.has(first.text)
    ? `starts with the shell keyword \`${first.text}\``
    : undefined;
}

function formatStepLabel(step: unknown, index: number): string {
  const name = findMember(step, 'name');

  return typeof name === 'string' ? `step "${name}"` : `step ${index + 1}`;
}

function collectTimeoutFindings(context: WorkflowContext, job: Job): WorkflowFinding[] {
  // GitHub refuses timeout-minutes on a job that calls a reusable workflow.
  if (findMember(job.definition, 'uses') !== undefined) {
    return [];
  }

  return findMember(job.definition, 'timeout-minutes') === undefined
    ? [{ path: context.path, line: job.line, message: `job ${job.id} sets no timeout-minutes` }]
    : [];
}

const pullRequestTriggers = ['pull_request', 'pull_request_target'];

// ci-design states the rule for a private repo only, so a public run leaves it alone.
function collectHeavyFindings(context: WorkflowContext, job: Job): WorkflowFinding[] {
  const trigger = pullRequestTriggers.find((name) => context.triggers.has(name));
  const reason = findHeavyReason(job);

  return context.profile === 'public' || trigger === undefined || reason === undefined
    ? []
    : [
        {
          path: context.path,
          line: job.line,
          message: `job ${job.id} is a heavy check, because it ${reason}, in a workflow that runs on ${trigger}; a private repo runs a heavy check nightly or on dispatch, never on each pull request`,
        },
      ];
}

// A KVM job runs on a GitHub-hosted Ubuntu runner, so only its setup step marks it. The fleet has
// no shared KVM step, and each repo's own command is listed here.
const kvmSetupCommands = new Set(['scripts/ci/check-kvm.sh', 'scripts/open-kvm.sh', 'ci:open-kvm']);

function findHeavyReason(job: Job): string | undefined {
  const runner = findHeavyRunner(findMember(job.definition, 'runs-on'));

  if (runner !== undefined) {
    return `runs on ${runner}`;
  }

  const command = collectSteps(job)
    .map((step) => findMember(step, 'run'))
    .filter((run): run is string => typeof run === 'string')
    .flatMap((run) => collectCommandNames(parseShellWords(run)) ?? [])
    .find((name) => kvmSetupCommands.has(name));

  return command === undefined ? undefined : `enables KVM through ${command}`;
}

// Any runner but a GitHub-hosted Ubuntu one counts as heavy: macOS, Windows, self-hosted, or a
// runner group. A runner chosen by an expression is left alone, because GitHub resolves it only
// when the job runs.
function findHeavyRunner(runsOn: unknown): string | undefined {
  if (findMember(runsOn, 'group') !== undefined) {
    return 'a runner group';
  }

  const labels = [runsOn, findMember(runsOn, 'labels')]
    .flat()
    .filter((label): label is string => typeof label === 'string');

  if (labels.some((label) => label.includes(expressionOpening))) {
    return undefined;
  }

  return labels.find((label) => !label.startsWith('ubuntu-'));
}

const setupBunPattern = /^oven-sh\/setup-bun(?:@|$)/u;
const cachePattern = /^actions\/cache(?:\/(?:restore|save))?(?:@|$)/u;

function collectCacheFindings(context: WorkflowContext, job: Job): WorkflowFinding[] {
  const steps = collectSteps(job);
  const uses = steps.map((step) => findMember(step, 'uses'));

  const isBunJob = uses.some(
    (action) => typeof action === 'string' && setupBunPattern.test(action),
  );

  return uses.flatMap((action, index) =>
    isBunJob && typeof action === 'string' && cachePattern.test(action)
      ? [
          {
            path: context.path,
            line: job.line,
            message: `job ${job.id}, ${formatStepLabel(steps[index], index)}: a Bun job uses ${action}; bun install --frozen-lockfile runs faster than the cache restore`,
          },
        ]
      : [],
  );
}

const checkoutPattern = /^actions\/checkout(?:@|$)/u;

// A blobless clone fetches every commit and tree, and git fetches a file's contents when a command
// first reads them, which suits a job that reads history but few old files. A job that reads many
// old files, one fetch each, clones them all and states so with an empty filter.
function collectCheckoutFindings(context: WorkflowContext, job: Job): WorkflowFinding[] {
  return collectSteps(job).flatMap((step, index) => {
    const action = findMember(step, 'uses');
    const inputs = findMember(step, 'with');
    const depth = findMember(inputs, 'fetch-depth');

    const isFullHistory =
      typeof action === 'string' && checkoutPattern.test(action) && (depth === 0 || depth === '0');

    return isFullHistory && typeof findMember(inputs, 'filter') !== 'string'
      ? [
          {
            path: context.path,
            line: job.line,
            message: `job ${job.id}, ${formatStepLabel(step, index)}: a checkout with fetch-depth: 0 sets filter: blob:none to clone the history without the file contents, or filter: '' when the job reads many old files`,
          },
        ]
      : [];
  });
}

function collectConcurrencyFindings(context: WorkflowContext): WorkflowFinding[] {
  const deployJobs = context.jobs.filter((job) => isDeployJob(job));
  const workflowConcurrency = findMember(context.workflow, 'concurrency');

  return [
    ...deployJobs.flatMap((job) => collectDeployFindings(context, job, workflowConcurrency)),
    ...(isChecksWorkflow(context)
      ? collectChecksFindings(context, deployJobs, workflowConcurrency)
      : []),
  ];
}

const deployJobPattern = /release|deploy|migrate/iu;

function isDeployJob(job: Job): boolean {
  const name = findMember(job.definition, 'name');

  return deployJobPattern.test(job.id) || (typeof name === 'string' && deployJobPattern.test(name));
}

function collectDeployFindings(
  context: WorkflowContext,
  job: Job,
  workflowConcurrency: unknown,
): WorkflowFinding[] {
  const concurrency = findMember(job.definition, 'concurrency');

  const hasOwnGroup =
    typeof findMember(concurrency, 'group') === 'string' &&
    findMember(concurrency, 'cancel-in-progress') === false;

  return [
    ...(hasOwnGroup
      ? []
      : [
          {
            path: context.path,
            line: job.line,
            message: `job ${job.id} releases or deploys, so it sets a job-level concurrency group with cancel-in-progress: false`,
          },
        ]),
    ...(isCancelling(workflowConcurrency)
      ? [
          {
            path: context.path,
            line: getTopLevelLine(context.lines, 'concurrency'),
            message: `the workflow-level cancel-in-progress: true can cancel job ${job.id}, which releases or deploys; set each concurrency group per job`,
          },
        ]
      : []),
  ];
}

function isCancelling(concurrency: unknown): boolean {
  return findMember(concurrency, 'cancel-in-progress') === true;
}

function getTopLevelLine(lines: readonly string[], key: string): number {
  const keyPattern = new RegExp(`^['"]?${RegExp.escape(key)}['"]?:`, 'u');

  return lines.findIndex((line) => keyPattern.test(line)) + 1 || 1;
}

function isChecksWorkflow(context: WorkflowContext): boolean {
  return context.triggers.has('pull_request') || context.triggers.has('push');
}

function collectChecksFindings(
  context: WorkflowContext,
  deployJobs: readonly Job[],
  workflowConcurrency: unknown,
): WorkflowFinding[] {
  const otherJobs = context.jobs.filter((job) => !deployJobs.includes(job));

  const isEveryJobCancelling =
    otherJobs.length > 0 &&
    otherJobs.every((job) => isCancelling(findMember(job.definition, 'concurrency')));

  const isCovered = isCancelling(workflowConcurrency) || isEveryJobCancelling;

  const workflowFindings =
    deployJobs.length > 0 || isCovered
      ? []
      : [
          {
            path: context.path,
            line: getTopLevelLine(context.lines, 'on'),
            message:
              'a checks workflow, which runs on pull_request or push, sets concurrency with cancel-in-progress: true',
          },
        ];

  const jobFindings =
    deployJobs.length === 0
      ? []
      : otherJobs
          .filter((job) => !isCancelling(findMember(job.definition, 'concurrency')))
          .map((job) => ({
            path: context.path,
            line: job.line,
            message: `job ${job.id} runs in a checks workflow beside a release or deploy job, so it sets a job-level concurrency group with cancel-in-progress: true`,
          }));

  return [
    ...workflowFindings,
    ...jobFindings,
    ...collectPerRunGroupFindings(
      context,
      workflowConcurrency,
      getTopLevelLine(context.lines, 'concurrency'),
    ),
    ...otherJobs.flatMap((job) =>
      collectPerRunGroupFindings(context, findMember(job.definition, 'concurrency'), job.line),
    ),
  ];
}

// A value that differs between two runs on the same branch gives each run its own group, which no
// later run cancels.
const perRunValues = ['github.sha', 'github.run_id', 'github.run_number', 'github.run_attempt'];

function collectPerRunGroupFindings(
  context: WorkflowContext,
  concurrency: unknown,
  line: number,
): WorkflowFinding[] {
  const group = findMember(concurrency, 'group');
  const references = typeof group === 'string' ? collectExpressionReferences(group) : [];
  const perRun = perRunValues.find((value) => references.includes(value));

  return perRun === undefined
    ? []
    : [
        {
          path: context.path,
          line,
          message: `the concurrency group holds ${perRun}, so no newer run cancels this one`,
        },
      ];
}

// A string literal in an expression may hold `}}`, so the end of an expression is found past them.
const expressionPattern = /\$\{\{(?<body>(?:'(?:[^']|'')*'|[^'])*?)\}\}/gsu;
const indexPattern = /\[\s*'(?<name>[A-Za-z_][\w-]*)'\s*\]/gu;
const stringPattern = /'(?:[^']|'')*'/gu;
const referencePattern = /[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+/gu;

// Only a context reference inside an expression changes between runs: the same words outside one,
// or in one of its string literals, are text. `github['sha']` reads the same value as `github.sha`.
function collectExpressionReferences(text: string): string[] {
  return [...text.matchAll(expressionPattern)].flatMap((expression) => {
    const body = (expression.groups?.['body'] ?? '')
      .replaceAll(indexPattern, '.$<name>')
      .replaceAll(stringPattern, "''");

    return [...body.matchAll(referencePattern)].map((reference) => reference[0]);
  });
}

function collectWorkflowRunFindings(context: WorkflowContext): WorkflowFinding[] {
  if (!context.triggers.has('workflow_run')) {
    return [];
  }

  const trigger = findMember(findMember(context.workflow, 'on'), 'workflow_run');
  const branches = findMember(trigger, 'branches');

  return isList(branches) && branches.length > 0
    ? []
    : [
        {
          path: context.path,
          line: getTopLevelLine(context.lines, 'on'),
          message:
            'the workflow_run trigger has no branches filter, so a run of the named workflow on any branch starts it',
        },
      ];
}

function runCLI(): void {
  const paths = parseCLIPaths(process.argv.slice(2));

  if (paths instanceof Error) {
    process.stderr.write(`workflows: ${paths.message}\nusage: run-workflows-check.ts [path...]\n`);

    process.exitCode = 2;

    return;
  }

  try {
    const findings = runWorkflowsCheck({
      cwd: process.cwd(),
      env: process.env,
      paths,
      profile: parseChecksProfile(process.env['CHECKS_PROFILE']),
      runProgram,
    });

    const isActions = process.env['GITHUB_ACTIONS'] === 'true';

    for (const finding of findings) {
      process.stdout.write(`${isActions ? formatAnnotation(finding) : formatLine(finding)}\n`);
    }

    if (findings.length > 0) {
      process.stdout.write(
        `workflows: ${findings.length} ${findings.length === 1 ? 'warning' : 'warnings'}; the workflow lint warns and does not fail yet\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`workflows: ${error instanceof Error ? error.message : String(error)}\n`);

    process.exitCode = 2;
  }
}

function parseCLIPaths(args: readonly string[]): string[] | Error {
  try {
    return parseArgs({ args: [...args], options: {}, allowPositionals: true, strict: true })
      .positionals;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function parseChecksProfile(value: string | undefined): ChecksProfile | undefined {
  return value === 'public' || value === 'private' ? value : undefined;
}

// GitHub reads a workflow command's properties up to `,` and `::`, and its message up to a
// newline, so each escapes its own characters.
function formatAnnotation(finding: WorkflowFinding): string {
  const file = escapeAnnotationData(finding.path).replaceAll(':', '%3A').replaceAll(',', '%2C');

  return `::warning file=${file},line=${finding.line}::${escapeAnnotationData(finding.message)}`;
}

function escapeAnnotationData(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function formatLine(finding: WorkflowFinding): string {
  return `${finding.path}:${finding.line}: ${finding.message}`;
}

if (import.meta.main) {
  runCLI();
}
