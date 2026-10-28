import { appendFile } from 'node:fs/promises';

type ReleaseShip = 'here' | 'dispatch' | 'none';

interface ReleaseRun {
  readonly event: string;

  // Strings, because GitHub passes every job output as one.
  readonly releasesCreated: string;
  readonly releaseOutputs: string;

  readonly checksResult: string;
  readonly binariesResult: string;

  readonly sha: string;
}

// release-please reads main through the API, so a run can tag a merge that is not its own commit,
// and the tag lands before the run's checks end. A run ships only its own checked commit.
export function pickReleaseShip(run: Readonly<ReleaseRun>): ReleaseShip {
  const checked = run.checksResult === 'success' && run.binariesResult === 'success';

  if (run.event === 'workflow_dispatch') {
    return checked ? 'here' : 'none';
  }

  if (run.releasesCreated !== 'true') {
    return 'none';
  }

  return checked && parseReleaseSHA(run.releaseOutputs) === run.sha ? 'here' : 'dispatch';
}

// A root package's release outputs hold its tagged commit under `sha`.
function parseReleaseSHA(releaseOutputs: string): string {
  const outputs: unknown = JSON.parse(releaseOutputs);

  if (
    typeof outputs !== 'object' ||
    outputs === null ||
    !('sha' in outputs) ||
    typeof outputs.sha !== 'string'
  ) {
    throw new Error(`the release outputs hold no tagged commit: ${releaseOutputs}`);
  }

  return outputs.sha;
}

async function main(): Promise<void> {
  try {
    const output = process.env['GITHUB_OUTPUT'];

    if (output === undefined) {
      throw new Error('GITHUB_OUTPUT is unset');
    }

    const ship = pickReleaseShip({
      event: process.env['GITHUB_EVENT_NAME'] ?? '',
      releasesCreated: process.env['RELEASES_CREATED'] ?? '',
      releaseOutputs: process.env['RELEASE_OUTPUTS'] ?? '',
      checksResult: process.env['CHECKS_RESULT'] ?? '',
      binariesResult: process.env['BINARIES_RESULT'] ?? '',
      sha: process.env['GITHUB_SHA'] ?? '',
    });

    await appendFile(output, `ship=${ship}\n`);
  } catch (error) {
    process.stderr.write(
      `pick-release-ship: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
