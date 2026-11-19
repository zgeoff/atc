import type { ExecutionProvider } from '@atc/plugin-api';

export const DIR_BYTES_SCRIPT = 'du -sk -- "$1"';
const KIB_LINE = /^(?<kib>\d+)\t/u;

export async function readHostDirBytes(
  provider: Pick<ExecutionProvider, 'runCommand'>,
  directory: string,
): Promise<number | null> {
  const run = await provider
    .runCommand({ argv: ['sh', '-c', DIR_BYTES_SCRIPT, 'sh', directory], cwd: '/' })
    .catch(() => null);

  const kib = run?.exitCode === 0 ? KIB_LINE.exec(run.stdout)?.groups?.['kib'] : undefined;

  return kib === undefined ? null : Number(kib) * 1024;
}
