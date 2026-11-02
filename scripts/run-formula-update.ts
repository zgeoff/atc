import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { z } from 'zod';

interface FormulaUpdate {
  // The checkout of the release, whose `dist/SHA256SUMS` holds each binary's checksum.
  readonly root: string;

  // The tap repository to clone and push, with any credential it needs.
  readonly tapURL: string;

  // The folder the tap is cloned into, as `tap/`.
  readonly workDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const MANIFEST_SCHEMA = z.object({ version: z.string().min(1) });

// A re-run after a failed push finds the formula already committed, so it commits nothing and
// pushes what the tap lacks.
export async function runFormulaUpdate(update: FormulaUpdate): Promise<void> {
  const manifestJSON: unknown = await Bun.file(join(update.root, 'package.json')).json();

  const manifest = MANIFEST_SCHEMA.parse(manifestJSON);
  const tap = join(update.workDir, 'tap');
  const env = { ...update.env };

  await $`git clone --quiet ${update.tapURL} ${tap}`.env(env).quiet();

  mkdirSync(join(tap, 'Formula'), { recursive: true });

  const formula =
    await $`bash ${join(update.root, 'scripts', 'build-formula.sh')} ${manifest.version} ${join(update.root, 'dist', 'SHA256SUMS')}`
      .env(env)
      .text();

  await Bun.write(join(tap, 'Formula', 'atc.rb'), formula);
  await $`git config user.name ${'github-actions[bot]'}`.cwd(tap).env(env);

  await $`git config user.email ${'41898282+github-actions[bot]@users.noreply.github.com'}`
    .cwd(tap)
    .env(env);

  await $`git add Formula/atc.rb`.cwd(tap).env(env);

  const staged = await $`git diff --cached --quiet`.cwd(tap).env(env).nothrow();

  if (staged.exitCode === 0) {
    process.stdout.write(`formula already at ${manifest.version}\n`);
  } else {
    await $`git commit --quiet -m ${`atc ${manifest.version}`}`.cwd(tap).env(env);
  }

  await $`git push --quiet`.cwd(tap).env(env);
}

if (import.meta.main) {
  try {
    await runFormulaUpdate({
      root: process.cwd(),
      tapURL: `https://x-access-token:${process.env['GH_TOKEN'] ?? ''}@github.com/${process.env['TAP'] ?? ''}.git`,
      workDir: process.cwd(),
      env: process.env,
    });
  } catch (error) {
    // the shell error names the command and its arguments, which hold the tap token
    process.stderr.write(
      `run-formula-update: ${error instanceof $.ShellError ? `a command exited ${error.exitCode}: ${error.stderr.toString().trim()}` : String(error)}\n`,
    );

    process.exit(1);
  }
}
