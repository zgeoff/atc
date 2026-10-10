export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * Reads the git `user.name` and `user.email` the daemon's host is
 * configured with, in the daemon's own environment so its global config
 * applies. Resolves to both when each is non-empty, and to null when either
 * is missing or git cannot run; it never throws.
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
    const proc = Bun.spawn(['git', 'config', '--get', key], {
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
