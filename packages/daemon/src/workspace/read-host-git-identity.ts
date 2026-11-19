import { tmpdir } from 'node:os';

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

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
    const subprocess = Bun.spawn(['git', 'config', '--global', '--get', key], {
      cwd: tmpdir(),
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });

    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      subprocess.exited,
    ]);

    const value = stdout.trim();

    return exitCode === 0 && value !== '' ? value : null;
  } catch {
    return null;
  }
}
