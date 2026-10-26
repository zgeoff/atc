// A cancelled release leaves a tag without its binaries or formula, and GitHub
// keeps one pending run per group, so a group that every branch shares lets
// one branch's push replace another branch's pending release.
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
const BRANCH_REF = `\${{ github.ref }}`;
const CANCEL_SCHEMA = z.union([z.boolean(), z.string()]);

const GROUP_SCHEMA = z.object({
  group: z.string(),
  'cancel-in-progress': CANCEL_SCHEMA.optional(),
});

const CONCURRENCY_SCHEMA = z.union([z.string(), GROUP_SCHEMA]);
const STEP_SCHEMA = z.object({ uses: z.string().optional() });

const JOB_SCHEMA = z.object({
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
  }

  return problems;
}

main();
