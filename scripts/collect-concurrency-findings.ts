import { collectExpressionReferences } from './collect-expression-references.ts';
import { findMember } from './find-member.ts';
import { getTopLevelLine } from './get-top-level-line.ts';
import { pullRequestTriggers } from './pull-request-triggers.ts';
import type { Job, WorkflowContext, WorkflowFinding } from './workflow-context.ts';

export function collectConcurrencyFindings(context: WorkflowContext): WorkflowFinding[] {
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
  const isQueued = isQueueGroup(concurrency ?? workflowConcurrency);

  return [
    ...(isQueued
      ? []
      : [
          {
            path: context.path,
            line: job.line,
            message: `job ${job.id} releases or deploys, so it or its workflow sets a concurrency group with cancel-in-progress: false`,
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

function isQueueGroup(concurrency: unknown): boolean {
  return (
    typeof findMember(concurrency, 'group') === 'string' &&
    findMember(concurrency, 'cancel-in-progress') === false
  );
}

function isCancelling(concurrency: unknown): boolean {
  return findMember(concurrency, 'cancel-in-progress') === true;
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

  const isEveryJobCovered =
    otherJobs.length > 0 &&
    otherJobs.every((job) => isChecksGroup(context, findMember(job.definition, 'concurrency')));

  const isCovered = isChecksGroup(context, workflowConcurrency) || isEveryJobCovered;

  const workflowFindings =
    deployJobs.length > 0 || isCovered
      ? []
      : [
          {
            path: context.path,
            line: getTopLevelLine(context.lines, 'on'),
            message:
              'a checks workflow, which runs on pull_request or push, sets concurrency with cancel-in-progress: true; a gate that runs only on a push to main may instead group by github.sha and never cancel',
          },
        ];

  const jobFindings =
    deployJobs.length === 0
      ? []
      : otherJobs
          .filter((job) => !isChecksGroup(context, findMember(job.definition, 'concurrency')))
          .map((job) => ({
            path: context.path,
            line: job.line,
            message: `job ${job.id} runs in a checks workflow beside a release or deploy job, so it sets a job-level concurrency group with cancel-in-progress: true`,
          }));

  // A workflow-level group that never cancels queues the release or deploy jobs, and the job-level
  // groups decide which checks cancel, so a per-run value there only keeps two runs apart.
  const isDeployQueue = deployJobs.length > 0 && isQueueGroup(workflowConcurrency);

  return [
    ...workflowFindings,
    ...jobFindings,
    ...(isDeployQueue
      ? []
      : collectPerRunGroupFindings(
          context,
          workflowConcurrency,
          getTopLevelLine(context.lines, 'concurrency'),
        )),
    ...otherJobs.flatMap((job) =>
      collectPerRunGroupFindings(context, findMember(job.definition, 'concurrency'), job.line),
    ),
  ];
}

function isChecksGroup(context: WorkflowContext, concurrency: unknown): boolean {
  return (
    isCancelling(concurrency) ||
    isGateGroup(context, concurrency) ||
    isDispatchGroup(context, concurrency)
  );
}

function isGateGroup(context: WorkflowContext, concurrency: unknown): boolean {
  const group = findMember(concurrency, 'group');
  const cancel = findMember(concurrency, 'cancel-in-progress');

  return (
    isMainGate(context) &&
    typeof group === 'string' &&
    collectExpressionReferences(group).includes('github.sha') &&
    (cancel === undefined || cancel === false)
  );
}

// A gate on main runs once for each commit, so a newer commit must not cancel the older run.
function isMainGate(context: WorkflowContext): boolean {
  const push = findMember(findMember(context.workflow, 'on'), 'push');
  const branches = [findMember(push, 'branches')].flat();

  return (
    !pullRequestTriggers.some((name) => context.triggers.has(name)) &&
    branches.length > 0 &&
    branches.every((branch) => branch === 'main')
  );
}

// A dispatched run whose group is a run-unique value shares the group with no other run, so no run
// cancels it, and every other run still cancels.
function isDispatchGroup(context: WorkflowContext, concurrency: unknown): boolean {
  const group = findMember(concurrency, 'group');

  return (
    typeof group === 'string' &&
    findNonDispatchGroup(group) !== undefined &&
    isCancellingOutsideDispatch(context, findMember(concurrency, 'cancel-in-progress'))
  );
}

// GitHub reads `a && b || c` as `(a && b) || c`, so a dispatched run takes its group from b and
// every other run from c. A `||` inside b ends b early, so b no longer reads as one value.
const dispatchGroupPattern =
  /^(?<prefix>[^$]*)\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&(?<dispatch>.+?)\|\|(?<other>.+)\}\}(?<suffix>[^$]*)$/su;

// Two dispatches at one commit share github.sha, and github.run_attempt starts at 1 in each run.
const dispatchRunValues = new Set(['github.run_id', 'github.run_number']);

// Returns the group a run other than a dispatched one reads, when a dispatched run's group is a
// lone run-unique value.
function findNonDispatchGroup(group: string): string | undefined {
  const split = dispatchGroupPattern.exec(group)?.groups;

  return split !== undefined && dispatchRunValues.has((split['dispatch'] ?? '').trim())
    ? `${split['prefix'] ?? ''}\${{ ${split['other'] ?? ''} }}${split['suffix'] ?? ''}`
    : undefined;
}

function isCancellingOutsideDispatch(context: WorkflowContext, cancel: unknown): boolean {
  const events = [...context.triggers].filter((event) => event !== 'workflow_dispatch');

  return (
    cancel === true ||
    (typeof cancel === 'string' && events.every((event) => isEventExpressionTrue(cancel, event)))
  );
}

const wholeExpressionPattern = /^\s*\$\{\{(?<body>.*)\}\}\s*$/su;
const eventTestPattern = /^\s*github\.event_name\s*(?<operator>==|!=)\s*'(?<event>[^']*)'\s*$/u;

// Reads only github.event_name tests joined by ||; any other expression counts as false.
function isEventExpressionTrue(text: string, event: string): boolean {
  const body = wholeExpressionPattern.exec(text)?.groups?.['body'];
  const terms = body === undefined ? [] : body.split('||');

  const tests = terms.flatMap((term) => {
    const test = eventTestPattern.exec(term)?.groups;

    return test === undefined ? [] : [test];
  });

  return (
    tests.length > 0 &&
    tests.length === terms.length &&
    tests.some((test) => (test['operator'] === '==') === (test['event'] === event))
  );
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
  const checked = typeof group === 'string' ? (findNonDispatchGroup(group) ?? group) : '';
  const references = collectExpressionReferences(checked);
  const allowed = isGateGroup(context, concurrency) ? 'github.sha' : undefined;
  const perRun = perRunValues.find((value) => value !== allowed && references.includes(value));

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
