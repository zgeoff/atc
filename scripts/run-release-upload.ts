import { join } from 'node:path';
import { $ } from 'bun';
import { z } from 'zod';

interface ReleaseUpload {
  // The checkout of the release, whose `dist/` holds the binaries and their SHA256SUMS.
  readonly root: string;

  // The repository the release belongs to, as `owner/name`.
  readonly repository: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const MANIFEST_SCHEMA = z.object({ version: z.string().min(1) });

// --clobber makes a re-run replace the assets a failed run left behind.
export async function runReleaseUpload(upload: ReleaseUpload): Promise<void> {
  const manifestJSON: unknown = await Bun.file(join(upload.root, 'package.json')).json();

  const manifest = MANIFEST_SCHEMA.parse(manifestJSON);
  const binaries = [...new Bun.Glob('dist/atc-*').scanSync({ cwd: upload.root })].toSorted();

  if (binaries.length === 0) {
    throw new Error(`no binaries match dist/atc-* under ${upload.root}`);
  }

  await $`gh release upload ${`@zgeoff/atc@${manifest.version}`} ${binaries} dist/SHA256SUMS --clobber --repo ${upload.repository}`
    .cwd(upload.root)
    .env({ ...upload.env });
}

if (import.meta.main) {
  try {
    await runReleaseUpload({
      root: process.cwd(),
      repository: process.env['GITHUB_REPOSITORY'] ?? '',
      env: process.env,
    });
  } catch (error) {
    process.stderr.write(
      `run-release-upload: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    process.exit(1);
  }
}
