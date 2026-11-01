import type { RunProgram } from './run-program.ts';

export type ChecksProfile = 'public' | 'private';

export interface ChecksProfileOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runProgram: RunProgram;
  readonly writeError: (text: string) => void;
}

// bun-checks picks the profile from the repo's visibility, so a run that CHECKS_PROFILE gives no
// profile, such as a pre-push hook, asks GitHub for the same visibility.
export function readChecksProfile(
  options: Readonly<ChecksProfileOptions>,
): ChecksProfile | undefined {
  const given = parseChecksProfile(options.env['CHECKS_PROFILE']);

  if (given !== undefined) {
    return given;
  }

  const visibility = readRepoVisibility(options);

  if (visibility instanceof Error) {
    options.writeError(
      `workflows: the repo's visibility is unknown, so every rule applies: ${visibility.message}\n`,
    );

    return undefined;
  }

  return visibility;
}

function parseChecksProfile(value: string | undefined): ChecksProfile | undefined {
  return value === 'public' || value === 'private' ? value : undefined;
}

const visibilityCommand = ['gh', 'repo', 'view', '--json', 'isPrivate', '--jq', '.isPrivate'];

function readRepoVisibility(options: Readonly<ChecksProfileOptions>): ChecksProfile | Error {
  try {
    const result = options.runProgram(visibilityCommand, { cwd: options.cwd, env: options.env });
    const answer = result.stdout.trim();

    if (result.exitCode === 0 && (answer === 'true' || answer === 'false')) {
      return answer === 'true' ? 'private' : 'public';
    }

    return new Error(
      `${visibilityCommand.join(' ')} exited ${result.exitCode}: ${result.stderr.trim() || answer}`,
    );
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
