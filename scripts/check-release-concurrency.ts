// GitHub keeps one pending run per group, so a shared release group lets one
// branch's push replace another branch's pending release. Each branch's release
// takes the latest mark, so its correction needs one group that they all share.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

function main(): void {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const text = readFileSync(join(root, WORKFLOW_PATH), 'utf8');
  const workflow = WORKFLOW_SCHEMA.parse(Bun.YAML.parse(text));
  const problems = collectReleaseConcurrencyProblems(workflow);

  for (const problem of problems) {
    console.error(`${WORKFLOW_PATH}: ${problem}`);
  }

  console.log(`check-release-concurrency: ${problems.length} problems`);

  if (problems.length > 0) {
    process.exit(1);
  }
}

const WORKFLOW_PATH = '.github/workflows/main.yml';
const RELEASE_ACTION = 'googleapis/release-please-action@';
const LATEST_SCRIPT = 'scripts/restore-latest-release.sh';
const BRANCH_REF = `\${{ github.ref }}`;
const CANCEL_SCHEMA = z.union([z.boolean(), z.string()]);

const GROUP_SCHEMA = z.object({
  group: z.string(),
  'cancel-in-progress': CANCEL_SCHEMA.optional(),
});

const CONCURRENCY_SCHEMA = z.union([z.string(), GROUP_SCHEMA]);
const OPTIONAL_TEXT_SCHEMA = z.string().optional();
const STEP_SCHEMA = z.object({ uses: OPTIONAL_TEXT_SCHEMA, run: OPTIONAL_TEXT_SCHEMA });
const NEEDS_SCHEMA = z.union([z.string(), z.array(z.string())]);
const OUTPUTS_SCHEMA = z.record(z.string(), z.string());

const JOB_SCHEMA = z.object({
  needs: NEEDS_SCHEMA.optional(),
  if: OPTIONAL_TEXT_SCHEMA,
  outputs: OUTPUTS_SCHEMA.optional(),
  concurrency: CONCURRENCY_SCHEMA.optional(),
  steps: z.array(STEP_SCHEMA).optional(),
});

const WORKFLOW_SCHEMA = z.object({
  concurrency: CONCURRENCY_SCHEMA.optional(),
  jobs: z.record(z.string(), JOB_SCHEMA),
});

function collectReleaseConcurrencyProblems(workflow: z.infer<typeof WORKFLOW_SCHEMA>): string[] {
  const problems: string[] = [];

  if (workflow.concurrency !== undefined) {
    problems.push('a workflow-level concurrency group reaches the release job; set it per job');
  }

  const releases = Object.entries(workflow.jobs).filter(([, job]) =>
    (job.steps ?? []).some((step) => step.uses?.startsWith(RELEASE_ACTION) === true),
  );

  if (releases.length === 0) {
    problems.push('no job runs release-please');

    return problems;
  }

  for (const [name, job] of releases) {
    const concurrency = job.concurrency;

    if (concurrency === undefined || typeof concurrency === 'string') {
      problems.push(`job ${name} sets no cancel-in-progress: false`);
    } else if (concurrency['cancel-in-progress'] !== false) {
      problems.push(`job ${name} can be cancelled; set cancel-in-progress: false`);
    }

    const group = typeof concurrency === 'string' ? concurrency : concurrency?.group;

    if (group?.includes(BRANCH_REF) !== true) {
      problems.push(`job ${name}'s group is shared by every branch; add ${BRANCH_REF} to it`);
    }

    if ((job.steps ?? []).some((step) => step.run?.includes(LATEST_SCRIPT) === true)) {
      problems.push(`job ${name} runs ${LATEST_SCRIPT}; run it in a job of its own`);
    }
  }

  const corrections = Object.entries(workflow.jobs).filter(
    ([, job]) =>
      !(job.steps ?? []).some((step) => step.uses?.startsWith(RELEASE_ACTION) === true) &&
      (job.steps ?? []).some((step) => step.run?.includes(LATEST_SCRIPT) === true),
  );

  if (corrections.length === 0) {
    problems.push(`no job of its own runs ${LATEST_SCRIPT}`);
  }

  for (const [name, job] of corrections) {
    const needs = typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []);
    const release = releases.find(([candidate]) => needs.includes(candidate));

    if (release === undefined) {
      problems.push(`job ${name} does not need the release-please job`);
    } else {
      problems.push(...collectTriggerProblems(name, job, release));
    }

    const concurrency = job.concurrency;

    if (concurrency === undefined || typeof concurrency === 'string') {
      problems.push(`job ${name} sets no cancel-in-progress: false`);
    } else if (concurrency['cancel-in-progress'] !== false) {
      problems.push(`job ${name} can be cancelled; set cancel-in-progress: false`);
    }

    const group = typeof concurrency === 'string' ? concurrency : concurrency?.group;

    if (group === undefined || group.includes('${{')) {
      problems.push(`job ${name} needs one fixed group that every branch shares`);
    }
  }

  return problems;
}

type Job = z.infer<typeof JOB_SCHEMA>;

// A failed asset step must not skip the correction, so the condition holds
// !cancelled() and reads the release job's output, which a failed job keeps.
function collectTriggerProblems(name: string, job: Job, release: [string, Job]): string[] {
  const [releaseName, releaseJob] = release;
  const problems: string[] = [];
  const condition = `\${{ !cancelled() && needs.${releaseName}.result != 'skipped' && (needs.${releaseName}.outputs.releases_created == 'true' || github.event_name == 'workflow_dispatch') }}`;

  if (releaseJob.outputs?.['releases_created']?.includes('.outputs.releases_created') !== true) {
    problems.push(`job ${releaseName} sets no releases_created output`);
  }

  if (job.if !== condition) {
    problems.push(`job ${name} runs on another condition than ${condition}`);
  }

  return problems;
}

main();
