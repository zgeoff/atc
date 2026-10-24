// Runs shellcheck over the POSIX sh scripts that atc runs through `sh -c`,
// mostly in a guest. lint:shell sees only tracked `.sh` files, so a script
// held in a string would otherwise go unchecked.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASKPASS_SCRIPT,
  CLAIM_DIR_SCRIPT,
  GUEST_CLONE_SCRIPT,
  PLACE_COPY,
  READ_PROJECT_SETTINGS_SCRIPT,
  REFRESH_COPY,
  REMOVE_DIR_SCRIPT,
  RESOLVE_DIR_SCRIPT,
  RESOLVE_HOME_SCRIPT,
  RESOLVE_UNLINKED_DIR_SCRIPT,
  VERIFY_SCRIPT,
} from '@atc/daemon';
import { ENTER_FROM_HOME_SCRIPT } from '@atc/execution-imp';
import { buildClaudeGuestLaunch, buildScratchLaunch } from '@atc/harness-claude';
import { buildCodexGuestLaunch } from '@atc/harness-codex';
import invariant from 'tiny-invariant';

async function main(): Promise<void> {
  if (Bun.which('shellcheck') === null) {
    console.error('shellcheck is not on the PATH; install it to run this check');
    process.exit(1);
  }

  const root = join(import.meta.dir, '..');
  const scripts = collectGuestScripts();
  const directory = mkdtempSync(join(tmpdir(), 'check-guest-scripts-'));

  try {
    // Each string goes to a file named for the constant or the builder that
    // holds it, so a finding names its source.
    for (const [name, script] of Object.entries(scripts)) {
      writeFileSync(join(directory, `${name}.sh`), script);
    }

    const files = [
      ...Object.keys(scripts).map((name) => join(directory, `${name}.sh`)),
      ...SCRIPT_FILES.map((file) => join(root, file)),
    ];

    const shellcheck = Bun.spawn(['shellcheck', '--norc', '--shell=sh', '--format=gcc', ...files], {
      stdout: 'pipe',
      stderr: 'inherit',
    });

    const output = await new Response(shellcheck.stdout).text();

    const exitCode = await shellcheck.exited;

    const findings = output
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.replace(`${directory}/`, '').replace(`${root}/`, ''));

    for (const finding of findings) {
      console.error(finding);
    }

    console.log(`check-guest-scripts: ${files.length} scripts, ${findings.length} findings`);

    if (exitCode !== 0) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// The imp provider's scripts, which it imports as text and runs through
// `sh -c`.
const SCRIPT_FILES = [
  'packages/execution/imp/src/check-guest-atc.sh',
  'packages/execution/imp/src/install-guest-atc.sh',
  'packages/execution/imp/src/link-guest-atc.sh',
  'packages/execution/imp/src/read-guest-atc.sh',
  'packages/execution/imp/src/ready-guest-dir.sh',
  'packages/execution/imp/src/unpack-archive.sh',
];

// A script that a function builds is checked as built from fixed sample
// inputs, which fill only its arguments and the variable names it unsets.
function collectGuestScripts(): Record<string, string> {
  return {
    ASKPASS_SCRIPT,
    CLAIM_DIR_SCRIPT,
    ENTER_FROM_HOME_SCRIPT,
    GUEST_CLONE_SCRIPT,
    PLACE_COPY,
    READ_PROJECT_SETTINGS_SCRIPT,
    REFRESH_COPY,
    REMOVE_DIR_SCRIPT,
    RESOLVE_DIR_SCRIPT,
    RESOLVE_HOME_SCRIPT,
    RESOLVE_UNLINKED_DIR_SCRIPT,
    VERIFY_SCRIPT,
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

await main();
