// Runs shellcheck over the POSIX sh scripts that atc runs through `sh -c`,
// mostly in a guest. lint:shell sees only tracked `.sh` files, so a script
// held in a string would otherwise go unchecked.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DAEMON_GUEST_SCRIPTS } from '@atc/daemon/guest-scripts';
import { IMP_GUEST_SCRIPTS } from '@atc/execution-imp/guest-scripts';
import { buildClaudeGuestLaunch, buildScratchLaunch } from '@atc/harness-claude/guest-scripts';
import { buildCodexGuestLaunch } from '@atc/harness-codex/guest-scripts';
import invariant from 'tiny-invariant';
import { readSourceFiles } from './read-source-files';

async function main(): Promise<void> {
  if (Bun.which('shellcheck') === null) {
    console.error('shellcheck is not on the PATH; install it to run this check');
    process.exit(1);
  }

  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const sources = readSourceFiles(root, 'packages').filter((file) => !TEST_FILE.test(file));
  const scripts = collectGuestScripts();

  const uncovered = sources.flatMap((file) =>
    collectExportedScripts(readFileSync(join(root, file), 'utf8'))
      .filter((name) => !(name in scripts))
      .map((name) => `${file} exports ${name}`),
  );

  for (const hit of uncovered) {
    console.error(`unchecked script: ${hit}; re-export it from its package's guest-scripts entry`);
  }

  const scriptFiles = sources.flatMap((file) =>
    collectTextImports(readFileSync(join(root, file), 'utf8')).map((specifier) =>
      join(root, dirname(file), specifier),
    ),
  );

  const directory = mkdtempSync(join(tmpdir(), 'check-guest-scripts-'));

  try {
    // Each string goes to a file named for the constant or the builder that
    // holds it, so a finding names its source.
    for (const [name, script] of Object.entries(scripts)) {
      writeFileSync(join(directory, `${name}.sh`), script);
    }

    const files = [...Object.keys(scripts).map((name) => `${name}.sh`), ...new Set(scriptFiles)];

    const shellcheck = Bun.spawn(['shellcheck', '--norc', '--shell=sh', '--format=gcc', ...files], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'inherit',
    });

    const output = await new Response(shellcheck.stdout).text();

    const exitCode = await shellcheck.exited;

    const findings = output
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.replace(`${root}/`, ''));

    for (const finding of findings) {
      console.error(finding);
    }

    console.log(
      `check-guest-scripts: ${files.length} scripts, ${findings.length} findings, ${uncovered.length} unchecked`,
    );

    if (exitCode !== 0 || uncovered.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const TEST_FILE = /\.test\.[cm]?[jt]sx?$|\/testing\//u;

// A script that a function builds is checked as built from fixed sample
// inputs, which fill only its arguments and the variable names it unsets.
function collectGuestScripts(): Record<string, string> {
  return {
    ...DAEMON_GUEST_SCRIPTS,
    ...IMP_GUEST_SCRIPTS,
    buildClaudeGuestLaunch: getLaunchScript(
      buildClaudeGuestLaunch('/home/u/.atc/guest', ['claude', '--resume'], {
        refusedEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
        bundleKey: 'k1',
        unsetEnv: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
      }).args,
    ),
    buildCodexGuestLaunch: getLaunchScript(
      buildCodexGuestLaunch('/home/u/.atc/guest', 'auth-r1', ['codex', '--yolo']).args,
    ),
    buildScratchLaunch: getLaunchScript(
      buildScratchLaunch('/tmp/atc/sessions/s1/scratch', ['claude']).args,
    ),
  };
}

function getLaunchScript(args: readonly string[]): string {
  const [flag, script] = args;

  invariant(flag === '-c' && script !== undefined, 'a launch runs sh -c with a script');

  return script;
}

// The names of the string constants a module exports as `*_SCRIPT`.
function collectExportedScripts(source: string): string[] {
  return [
    ...source.matchAll(
      /^export const (?<name>[A-Z][A-Z0-9_]*_SCRIPT)(?::\s*string)?\s*=\s*(?:String\.raw\s*)?[`'"]/gmu,
    ),
  ].map((match) => match.groups?.['name'] ?? '');
}

// The `.sh` files a module imports as text, relative to the module.
function collectTextImports(source: string): string[] {
  return [...source.matchAll(/from '(?<specifier>\.[^']*\.sh)' with \{ type: 'text' \}/gu)].map(
    (match) => match.groups?.['specifier'] ?? '',
  );
}

await main();
