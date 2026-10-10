import { tmpdir } from 'node:os';

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * Reads the git `user.name` and `user.email` of the daemon host's global
 * config, so no repository's own config applies, whatever directory or
 * repository the daemon's environment points git at. Resolves to both when
 * each is non-empty, and to null when either is missing or git cannot run;
 * it never throws.
 */
export async function readHostGitIdentity(): Promise<GitIdentity | null> {
  const [name, email] = await Promise.all([
    readConfigValue('user.name'),
    readConfigValue('user.email'),
  ]);

  if (name === null || email === null) {
    return null;
  }

  return { name, email };
}

async function readConfigValue(key: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', 'config', '--global', '--get', key], {
      cwd: tmpdir(),
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });

    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    const value = stdout.trim();

    return exitCode === 0 && value !== '' ? value : null;
  } catch {
    return null;
  }
}
