import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FEATURE_INPUT_FIELDS } from '@atcx/contract/light';
import { z } from 'zod';
import { collectContractChanges } from './collect-contract-changes';
import type { ContractSchemas } from './collect-contract-changes';
import { HARMLESS_INPUT_FIELDS } from './harmless-input-fields';
import { isBreakingMarked } from './is-breaking-marked';
import { pickContractCompatFailures } from './pick-contract-compat-failures';

const TAG_PATTERN = '@zgeoff/atc@*';
const SOURCE = 'packages/contract/src';
const PROCEDURE_SCHEMAS = z.object({ input: z.unknown(), output: z.unknown() });

const SCHEMAS = z.object({
  procedures: z.record(z.string(), PROCEDURE_SCHEMAS),
  event: z.unknown(),
});

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));

  const tag = await readLatestTag(root);

  if (tag === null) {
    console.error(
      `check-contract-compat: no ${TAG_PATTERN} tag in the clone; fetch the tags, such as with fetch-depth 0`,
    );

    process.exitCode = 1;

    return;
  }

  const work = mkdtempSync(join(tmpdir(), 'check-contract-compat-'));

  try {
    const oldSource = join(work, 'before');
    const newSource = join(work, 'after');

    await extractContractSource(root, tag, oldSource);

    linkContractSource(root, newSource);

    const before = await readSchemas(root, oldSource);
    const after = await readSchemas(root, newSource);

    const messages = [process.env['PR_TITLE'] ?? '', ...(await readCommitMessages(root, tag))];

    const failures = pickContractCompatFailures(
      collectContractChanges(before, after),
      { features: FEATURE_INPUT_FIELDS, harmless: HARMLESS_INPUT_FIELDS },
      isBreakingMarked(messages),
    );

    for (const failure of failures) {
      console.error(failure);
    }

    console.log(`check-contract-compat: against ${tag}, ${failures.length} failures`);

    if (failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function readLatestTag(root: string): Promise<string | null> {
  const listed = await runGit(root, ['tag', '--list', TAG_PATTERN, '--sort=-v:refname']);

  return listed.split('\n').find((line) => line !== '') ?? null;
}

async function readCommitMessages(root: string, tag: string): Promise<string[]> {
  const log = await runGit(root, ['log', `${tag}..HEAD`, '--format=%B%x00']);

  return log.split('\0').filter((message) => message.trim() !== '');
}

// The old source runs from a folder of its own with the root's dependencies linked in, so it
// resolves the same zod and oRPC as the current source.
async function extractContractSource(root: string, tag: string, folder: string): Promise<void> {
  mkdirSync(folder, { recursive: true });

  const archive = Bun.spawn(['git', 'archive', '--format=tar', tag, SOURCE], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const unpacking = Bun.spawn(['tar', '-x', '-C', folder], {
    stdin: new Response(archive.stdout),
    stderr: 'inherit',
  });

  if ((await unpacking.exited) !== 0 || (await archive.exited) !== 0) {
    throw new Error(`could not extract ${SOURCE} at ${tag}`);
  }

  linkDependencies(root, folder);
}

function linkContractSource(root: string, folder: string): void {
  mkdirSync(join(folder, 'packages/contract'), { recursive: true });
  symlinkSync(join(root, SOURCE), join(folder, SOURCE));
  linkDependencies(root, folder);
}

function linkDependencies(root: string, folder: string): void {
  symlinkSync(join(root, 'node_modules'), join(folder, 'node_modules'));

  const contractModules = join(root, 'packages/contract/node_modules');

  if (existsSync(contractModules)) {
    mkdirSync(join(folder, 'packages/contract'), { recursive: true });
    symlinkSync(contractModules, join(folder, 'packages/contract/node_modules'));
  }
}

// The entry holds a static import of the contract, so the folder's own module resolution applies.
async function readSchemas(root: string, folder: string): Promise<ContractSchemas> {
  const entry = join(folder, 'write-schemas.ts');

  await Bun.write(
    entry,
    [
      `import * as contract from './${SOURCE}/index.ts';`,
      `import { writeContractSchemas } from '${join(import.meta.dir, 'write-contract-schemas.ts')}';`,
      'writeContractSchemas(contract);',
      '',
    ].join('\n'),
  );

  const writing = Bun.spawn([process.execPath, entry], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const output = await new Response(writing.stdout).text();

  if ((await writing.exited) !== 0) {
    throw new Error(`could not read the contract schemas in ${folder}`);
  }

  return SCHEMAS.parse(JSON.parse(output));
}

async function runGit(root: string, args: readonly string[]): Promise<string> {
  const running = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'inherit' });

  const output = await new Response(running.stdout).text();

  if ((await running.exited) !== 0) {
    throw new Error(`git ${args.join(' ')} failed`);
  }

  return output;
}

await main();
